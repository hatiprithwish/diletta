"""The /eval/load/* client (diletta_evals.load.api) against a mocked transport: the signed token, the typed answers and
refusals, and which calls are retried."""

import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
import jwt
import pytest

from diletta_evals.config import TestHostSettings as HostSettings
from diletta_evals.eval_jwt import generate_key_pair
from diletta_evals.load import api as load_api
from diletta_evals.load.api import LoadApiClient, LoadApiError, iso_utc
from diletta_evals.load.config import LoadSettings
from diletta_evals.types import eval_load

PRIVATE_JWK, PUBLIC_JWKS = generate_key_pair("load-test-kid")
SETTINGS = LoadSettings(
    api_url="https://worker.example",
    private_jwk=PRIVATE_JWK,
    company_id="co_load",
    connection_id="cn_load",
    test_host=HostSettings(issuer="https://host.example", admin_secret="secret"),
    origin="https://app.example.com",
    chatbot_id=None,
)
SNAPSHOT = {"spentMicros": 10, "budgetMicros": 1_000, "heldMicros": 0, "openReservationCount": 0}
OPERATION = {"count": 1, "p50Ms": 1, "p95Ms": 2, "maxMs": 3}
RESERVATION = "6f1c3a52-0d41-4c0e-9f43-0b2f7d7c1a11"


def client_for(answers: list[httpx.Response | Exception]) -> tuple[LoadApiClient, list[httpx.Request]]:
    sent: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    return LoadApiClient(SETTINGS, http), sent


def refusal(status: int, failure: str) -> httpx.Response:
    return httpx.Response(status, json={"isSuccess": False, "message": "Refused", "failure": failure})


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    async def instant(_seconds: float) -> None:
        return None

    monkeypatch.setattr(load_api.asyncio, "sleep", instant)


def test_signs_every_request_for_the_load_company_and_reads_typed_answers() -> None:
    window = {
        "isSuccess": True,
        "message": "Load window started",
        "startedAt": "2026-11-02T10:00:00.123Z",
        "budget": SNAPSHOT,
    }

    async def scenario() -> eval_load.EvalLoadWindowApiResponse:
        client, sent = client_for([httpx.Response(200, json=window)])
        answer = await client.start_window()
        request = sent[0]
        assert (request.method, str(request.url)) == ("POST", "https://worker.example/eval/load/window")
        claims = jwt.decode(
            request.headers["Authorization"].removeprefix("Bearer "),
            jwt.algorithms.ECAlgorithm.from_jwk(json.dumps(PUBLIC_JWKS["keys"][0])),
            algorithms=["ES256"],
            audience="diletta-eval",
        )
        assert (claims["company"], claims["connection"]) == ("co_load", "cn_load")
        return answer

    answer = asyncio.run(scenario())
    assert answer.budget.budgetMicros == 1_000
    assert answer.startedAt == datetime(2026, 11, 2, 10, 0, 0, 123000, tzinfo=UTC)


def test_the_summary_sends_the_window_start_with_milliseconds_and_a_z() -> None:
    summary = {
        "isSuccess": True,
        "message": "Load summary read",
        "budget": SNAPSHOT,
        "timings": {"admitTurn": OPERATION, "reserve": OPERATION, "settle": OPERATION},
        "timingsSince": 1,
        "modelCalls": {"callCount": 0, "pendingCount": 0, "costMicros": 0},
        "outbox": {"eventCount": 0, "publishedCount": 0, "unpublishedCount": 0, "lagP50Ms": 0, "lagP95Ms": 0, "lagMaxMs": 0},
    }

    async def scenario() -> list[httpx.Request]:
        client, sent = client_for([httpx.Response(200, json=summary)])
        await client.summary(datetime(2026, 11, 2, 10, 0, 0, 123456, tzinfo=UTC))
        return sent

    sent = asyncio.run(scenario())
    assert sent[0].method == "GET"
    assert sent[0].url.params["since"] == "2026-11-02T10:00:00.123Z"
    assert iso_utc(datetime(2026, 11, 2, 12, 0, tzinfo=UTC)) == "2026-11-02T12:00:00.000Z"


def test_a_refusal_is_typed_and_a_5xx_is_a_server_error() -> None:
    async def scenario() -> tuple[LoadApiError, LoadApiError]:
        client, _ = client_for([refusal(403, "Forbidden"), refusal(500, "ServerError")])
        with pytest.raises(LoadApiError) as forbidden:
            await client.reserve(5)
        with pytest.raises(LoadApiError) as failed:
            await client.reserve(5)
        return forbidden.value, failed.value

    forbidden, failed = asyncio.run(scenario())
    assert forbidden.failure is eval_load.Failure.Forbidden
    assert not forbidden.is_server_error
    assert failed.failure is eval_load.Failure.ServerError
    assert failed.is_server_error


def test_an_answer_of_another_shape_is_an_error_not_a_guess() -> None:
    async def scenario() -> None:
        client, _ = client_for([httpx.Response(200, json={"isSuccess": True, "message": "x"})])
        with pytest.raises(LoadApiError, match="doesn't match"):
            await client.release(UUID(RESERVATION))

    asyncio.run(scenario())


def test_reads_are_retried_on_a_5xx_but_a_reserve_is_sent_once() -> None:
    window = {"isSuccess": True, "message": "ok", "startedAt": "2026-11-02T10:00:00.000Z", "budget": SNAPSHOT}

    async def scenario() -> tuple[int, int]:
        retried, sent = client_for([refusal(500, "ServerError"), httpx.ReadTimeout("slow"), httpx.Response(200, json=window)])
        await retried.start_window()
        once, once_sent = client_for([refusal(500, "ServerError"), httpx.Response(200, json={})])
        with pytest.raises(LoadApiError):
            await once.reserve(5)
        return len(sent), len(once_sent)

    assert asyncio.run(scenario()) == (3, 1)


def test_a_refusal_other_than_a_5xx_is_not_retried() -> None:
    async def scenario() -> int:
        client, sent = client_for([refusal(403, "Forbidden"), httpx.Response(200, json={})])
        with pytest.raises(LoadApiError):
            await client.start_window()
        return len(sent)

    assert asyncio.run(scenario()) == 1


def test_an_unreachable_backend_is_status_zero() -> None:
    async def scenario() -> LoadApiError:
        client, _ = client_for([httpx.ConnectError("down")] * (load_api.RETRIES + 1))
        with pytest.raises(LoadApiError) as error:
            await client.start_window()
        return error.value

    error = asyncio.run(scenario())
    assert error.status == 0
    assert error.is_server_error
