"""The /eval/* client (diletta_evals.client) against a mocked transport: headers, typed refusals, and which calls
are retried."""

import json

import httpx
import jwt
import pytest

from diletta_evals.client import RETRIES, EvalApiClient, EvalApiError
from diletta_evals.config import HarnessConfig, HostKind
from diletta_evals.constants import EVAL_HOST_TOKEN_HEADER
from diletta_evals.eval_jwt import generate_key_pair
from diletta_evals.types import eval_api

PRIVATE_JWK, PUBLIC_JWKS = generate_key_pair("test-kid")
CONFIG = HarnessConfig(
    api_url="https://worker.example",
    private_jwk=PRIVATE_JWK,
    company_id="co_1",
    connection_id="cn_1",
    host_user="eval-user",
    host_kind=HostKind.TEST_HOST,
    test_host=None,
)
GRADER_OUTPUT = {"schemaVersion": 1, "checks": [], "error": "The attempt didn't run"}
RESULT = eval_api.RecordEvalResultApiRequest.model_validate(
    {"caseId": "case_1", "attempt": 1, "hasPassed": False, "graderOutput": GRADER_OUTPUT, "latencyMs": None}
)


def client_for(answers: list[httpx.Response | Exception]) -> tuple[EvalApiClient, list[httpx.Request]]:
    sent: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    http = httpx.Client(transport=httpx.MockTransport(handle))
    return EvalApiClient(CONFIG, http, sleep=lambda _seconds: None), sent


def refusal(status: int, failure: str) -> httpx.Response:
    return httpx.Response(status, json={"isSuccess": False, "message": "Refused", "failure": failure})


def test_signs_every_request_and_sends_the_host_token_only_where_the_host_is_reached() -> None:
    client, sent = client_for(
        [
            httpx.Response(200, json={"isSuccess": True, "message": "ok", "isReset": True}),
            httpx.Response(201, json={"isSuccess": True, "message": "ok"}),
        ]
    )
    client.reset("run_1", "host-token")
    client.record_result("run_1", RESULT)
    reset, result = sent
    assert str(reset.url) == "https://worker.example/eval/runs/run_1/reset"
    assert reset.headers[EVAL_HOST_TOKEN_HEADER] == "host-token"
    assert EVAL_HOST_TOKEN_HEADER not in result.headers
    token = result.headers["Authorization"].removeprefix("Bearer ")
    public_key = jwt.PyJWK(PUBLIC_JWKS["keys"][0])
    claims = jwt.decode(token, public_key, algorithms=["ES256"], audience="diletta-eval")
    assert (claims["company"], claims["connection"], claims["sub"]) == ("co_1", "cn_1", "eval-user")
    assert json.loads(result.content)["caseId"] == "case_1"


def test_a_refusal_carries_its_typed_failure() -> None:
    client, _ = client_for([refusal(404, "NotFound")])
    with pytest.raises(EvalApiError) as raised:
        client.finish("run_1", eval_api.FinishEvalRunApiRequest(isComplete=True))
    assert raised.value.status == 404
    assert raised.value.failure is eval_api.Failure.NotFound
    assert not raised.value.is_transient


def test_retries_a_safe_call_on_a_dropped_connection_or_a_5xx() -> None:
    client, sent = client_for(
        [
            httpx.ConnectError("reset by peer"),
            refusal(502, "HostFailed"),
            httpx.Response(200, json={"isSuccess": True, "message": "ok", "isReset": True}),
        ]
    )
    assert client.reset("run_1", "host-token").isReset
    assert len(sent) == 3


def test_gives_up_after_its_retries_and_never_retries_a_refusal() -> None:
    client, sent = client_for([refusal(500, "ServerError")] * (RETRIES + 1))
    with pytest.raises(EvalApiError):
        client.reset("run_1", "host-token")
    assert len(sent) == RETRIES + 1

    client, sent = client_for([refusal(400, "Invalid")])
    with pytest.raises(EvalApiError):
        client.record_result("run_1", RESULT)
    assert len(sent) == 1


def test_a_retried_result_refused_as_duplicate_was_recorded_by_the_lost_try() -> None:
    client, sent = client_for([httpx.ReadTimeout("lost answer"), refusal(409, "Duplicate")])
    assert client.record_result("run_1", RESULT).isSuccess
    assert len(sent) == 2

    # DEV_NOTE: A Duplicate on the first try is a real refusal: that attempt was already graded
    client, _ = client_for([refusal(409, "Duplicate")])
    with pytest.raises(EvalApiError):
        client.record_result("run_1", RESULT)


def test_never_retries_an_attempt() -> None:
    client, sent = client_for([refusal(503, "ChatbotUnavailable")])
    request = eval_api.RunEvalAttemptApiRequest.model_validate(
        {"caseId": "case_1", "attempt": 1, "messages": [{"role": "user", "text": "Hi"}]}
    )
    with pytest.raises(EvalApiError) as raised:
        client.run_attempt("run_1", request, "host-token")
    assert raised.value.failure is eval_api.Failure.ChatbotUnavailable
    assert len(sent) == 1


def test_an_answer_of_another_shape_is_an_error() -> None:
    client, _ = client_for([httpx.Response(200, json={"isSuccess": True})])
    with pytest.raises(EvalApiError, match="doesn't match"):
        client.finish("run_1", eval_api.FinishEvalRunApiRequest(isComplete=True))


JUDGE = eval_api.EvalJudgeApiRequest(conversationId="conv_1", rubric="Confirms the note")
VERDICT = {
    "isSuccess": True,
    "message": "Attempt judged",
    "hasPassed": True,
    "reason": "Confirms the note.",
    "provider": "anthropic",
    "model": "claude-sonnet-5-5",
    "promptVersion": 1,
}


def test_asks_the_judge_with_no_host_token_and_resends_it_on_a_dropped_connection_or_a_500() -> None:
    client, sent = client_for(
        [httpx.ConnectError("reset"), refusal(500, "ServerError"), httpx.Response(200, json=VERDICT)]
    )
    judged = client.judge("run_1", JUDGE)
    assert judged.hasPassed and judged.model == "claude-sonnet-5-5"
    assert len(sent) == 3
    assert str(sent[0].url) == "https://worker.example/eval/runs/run_1/judge"
    assert EVAL_HOST_TOKEN_HEADER not in sent[0].headers
    assert json.loads(sent[0].content) == {"conversationId": "conv_1", "rubric": "Confirms the note"}


def test_never_resends_a_judge_refused_as_unavailable() -> None:
    client, sent = client_for([refusal(503, "JudgeUnavailable")])
    with pytest.raises(EvalApiError) as raised:
        client.judge("run_1", JUDGE)
    assert raised.value.failure is eval_api.Failure.JudgeUnavailable
    assert len(sent) == 1


def test_finishes_a_stopped_run_with_why() -> None:
    client, sent = client_for(
        [
            httpx.Response(
                200,
                json={
                    "isSuccess": True,
                    "message": "ok",
                    "status": 4,
                    "statusLabel": "Failed",
                    "caseCount": 1,
                    "passAllKCount": 0,
                    "hasPassed": False,
                    "costUsd": "0.010000",
                },
            )
        ]
    )
    client.finish(
        "run_1",
        eval_api.FinishEvalRunApiRequest(isComplete=False, failure=eval_api.EvalRunFailure.number_1),
    )
    assert json.loads(sent[0].content) == {"isComplete": False, "failure": 1}
