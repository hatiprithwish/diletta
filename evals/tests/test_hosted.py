"""The hosted runner's steps (diletta_evals.hosted, M7-9) against the run loop's fake API and host: each step answers
plain JSON, never raises, and turns what would stop the CLI's run into {"stop"}."""

import asyncio
import json

import pytest
from test_runner import CASE, RUBRIC_CASE, FakeClient, FakeHost

from diletta_evals import hosted
from diletta_evals.client import EvalApiError
from diletta_evals.config import ConfigError, HostKind
from diletta_evals.constants import (
    RUN_FAILURE_HOST_UNAVAILABLE,
    RUN_FAILURE_JUDGE_UNAVAILABLE,
    RUN_FAILURE_SERVER_ERROR,
)
from diletta_evals.eval_jwt import generate_key_pair
from diletta_evals.hosts.base import HostLoginError
from diletta_evals.runner import EvalRunner
from diletta_evals.types import eval_api

PRIVATE_JWK, _ = generate_key_pair("hosted-test")
EREGISTER_LOGIN = {
    "companyPublicId": "co_1",
    "connectionPublicId": "cn_1",
    "login": {
        "kind": "eregister",
        "hostUser": "uid-eval",
        "firebaseApiKey": "web-key",
        "email": "eval@example.com",
        "password": "secret-password",
    },
}


def runner_for(client: FakeClient, host: FakeHost | None = None) -> EvalRunner:
    return EvalRunner(client, host or FakeHost(), out=client.out)


def test_reads_the_backend_login_into_the_clis_settings() -> None:
    config = hosted.harness_config(EREGISTER_LOGIN, api_url="https://worker.example/", private_jwk=PRIVATE_JWK)
    assert (config.api_url, config.company_id, config.connection_id) == ("https://worker.example", "co_1", "cn_1")
    assert config.host_kind is HostKind.EREGISTER and config.host_user == "uid-eval"
    assert config.eregister is not None and config.eregister.password == "secret-password"

    test_host = hosted.harness_config(
        {
            **EREGISTER_LOGIN,
            "login": {
                "kind": "test_host",
                "hostUser": "eval-test-user",
                "issuer": "https://test-host.example/",
                "adminSecret": "admin",
            },
        },
        api_url="https://worker.example",
        private_jwk=PRIVATE_JWK,
    )
    assert test_host.test_host is not None and test_host.test_host.issuer == "https://test-host.example"


def test_an_unreadable_login_names_the_field_never_a_value() -> None:
    login = {**EREGISTER_LOGIN, "login": {k: v for k, v in EREGISTER_LOGIN["login"].items() if k != "email"}}
    with pytest.raises(ConfigError) as raised:
        hosted.harness_config(login, api_url="https://worker.example", private_jwk=PRIVATE_JWK)
    assert "email" in str(raised.value)
    assert "secret-password" not in str(raised.value)
    with pytest.raises(ConfigError):
        hosted.harness_config({"companyPublicId": "co_1"}, api_url="x", private_jwk=PRIVATE_JWK)


def test_start_signs_in_starts_the_queued_run_and_answers_json_only() -> None:
    client, host = FakeClient(), FakeHost()
    started = asyncio.run(hosted.start(runner_for(client, host), host, "run_q"))
    assert host.prepared == 1
    body = json.loads(client.started_with.model_dump_json())
    assert body.keys() == {"runId", "harnessVersion"} and body["runId"] == "run_q"
    assert started["runId"] == "run_1" and started["k"] == 2
    assert [case["publicId"] for case in started["cases"]] == ["case_1"]
    json.dumps(started)


def test_a_host_that_wont_sign_in_stops_the_run_as_the_hosts() -> None:
    client = FakeClient()

    class FailingPrepare(FakeHost):
        async def prepare(self) -> None:
            raise HostLoginError("eRegister test user sign-in failed: HTTP 400 INVALID_LOGIN_CREDENTIALS")

    failing = FailingPrepare()
    started = asyncio.run(hosted.start(runner_for(client, failing), failing, "run_q"))
    assert started["stop"]["failure"] == RUN_FAILURE_HOST_UNAVAILABLE.value
    assert client.events == []


def test_an_attempt_answers_its_verdict() -> None:
    client = FakeClient()
    runner = runner_for(client)
    answer = asyncio.run(hosted.attempt(runner, client, "run_1", CASE, 1))
    assert answer == {"hasPassed": True, "error": None}
    assert client.events == ["attempt 1", "result 1"]


def test_a_replayed_attempt_is_recorded_failed_as_interrupted_and_never_sent_again() -> None:
    duplicate = EvalApiError(409, "This eval attempt already ran", eval_api.Failure.Duplicate)
    client = FakeClient(refuse_attempt=(1, duplicate))
    answer = asyncio.run(hosted.attempt(runner_for(client), client, "run_1", CASE, 1))
    assert answer == {"hasPassed": False, "error": hosted.INTERRUPTED_ATTEMPT}
    [result] = client.results
    assert not result.hasPassed
    assert result.graderOutput.error is not None and result.graderOutput.error.root == hosted.INTERRUPTED_ATTEMPT


def test_an_unreachable_judge_stops_the_run_after_recording_the_attempt() -> None:
    refusal = EvalApiError(503, "The judge model couldn't be reached", eval_api.Failure.JudgeUnavailable)
    client = FakeClient(case=RUBRIC_CASE, refuse_judge=refusal)
    answer = asyncio.run(hosted.attempt(runner_for(client), client, "run_1", RUBRIC_CASE, 1))
    assert answer["hasPassed"] is False
    assert answer["stop"]["failure"] == RUN_FAILURE_JUDGE_UNAVAILABLE.value
    assert client.events[-1] == "result 1"


def test_a_backend_fault_on_an_attempt_stops_the_run_without_raising() -> None:
    client = FakeClient(refuse_attempt=(1, EvalApiError(500, "Server error", eval_api.Failure.ServerError)))
    answer = asyncio.run(hosted.attempt(runner_for(client), client, "run_1", CASE, 1))
    assert answer["stop"]["failure"] == RUN_FAILURE_SERVER_ERROR.value
    assert client.results == []


def test_reset_and_finish() -> None:
    client = FakeClient()
    assert asyncio.run(hosted.reset(runner_for(client), "run_1")) == {"isReset": True}
    finished = asyncio.run(hosted.finish(client, "run_1", None))
    assert finished["status"] == "Done"
    assert client.finish_request is not None and client.finish_request.isComplete

    refused = FakeClient(refuse_reset=EvalApiError(500, "Server error", eval_api.Failure.ServerError))
    reset = asyncio.run(hosted.reset(runner_for(refused), "run_1"))
    assert reset["isReset"] is False and reset["stop"]["failure"] == RUN_FAILURE_SERVER_ERROR.value
    stopped = asyncio.run(hosted.finish(refused, "run_1", reset["stop"]))
    assert stopped["status"] == "Failed"
    assert refused.finish_request is not None
    assert refused.finish_request.failure is RUN_FAILURE_SERVER_ERROR


# ─── The chain of Workflow instances (ADR 0007 › Chained instances)

FIRST_LINK = {"companyPublicId": "co_1", "runPublicId": "run_q"}
CASES = [{"publicId": "case_1"}, {"publicId": "case_2"}]


def test_the_backends_first_link_is_start_and_named_by_the_run() -> None:
    assert hosted.stage_of(FIRST_LINK) == "start"
    assert hosted.link_id(hosted.Link(**FIRST_LINK)) == "run_q"
    with pytest.raises(ConfigError):
        hosted.stage_of({**FIRST_LINK, "stage": "later"})


def test_walks_every_attempt_of_every_case_then_ends() -> None:
    link = hosted.after_start(FIRST_LINK, {"runId": "run_q", "k": 2, "cases": CASES})
    seen: list[str] = []
    while link is not None and link["stage"] == "attempt":
        seen.append(hosted.link_id(link))
        link = hosted.after_attempt(link, {"hasPassed": True, "error": None})
    assert seen == ["run_q-c1-a1", "run_q-c1-a2", "run_q-c2-a1", "run_q-c2-a2"]
    assert link == {"companyPublicId": "co_1", "runPublicId": "run_q", "resumedCount": 0, "stage": "end", "stop": None}
    assert hosted.link_id(link) == "run_q-end"


def test_a_stop_at_an_attempt_skips_to_the_end_with_it() -> None:
    first = hosted.after_start(FIRST_LINK, {"runId": "run_q", "k": 3, "cases": CASES})
    assert first is not None
    stop = {"failure": RUN_FAILURE_SERVER_ERROR.value, "message": "EvalApiError: HTTP 500"}
    ended = hosted.after_attempt(first, {"hasPassed": False, "error": None, "stop": stop})
    assert ended["stage"] == "end" and ended["stop"] == stop


def test_a_start_that_stopped_has_no_next_link_and_no_cases_go_straight_to_the_end() -> None:
    stop = {"failure": RUN_FAILURE_HOST_UNAVAILABLE.value, "message": "HostLoginError: INVALID_LOGIN_CREDENTIALS"}
    assert hosted.after_start(FIRST_LINK, {"stop": stop}) is None
    ended = hosted.after_start(FIRST_LINK, {"runId": "run_q", "k": 3, "cases": []})
    assert ended is not None and ended["stage"] == "end" and ended["stop"] is None


def test_a_link_holds_ids_cases_and_where_it_is_only_and_the_binding_gets_the_ids() -> None:
    link = hosted.after_start(FIRST_LINK, {"runId": "run_q", "k": 1, "cases": CASES})
    assert link is not None
    assert set(link) == {
        "companyPublicId",
        "runPublicId",
        "resumedCount",
        "stage",
        "k",
        "cases",
        "done",
        "caseIndex",
        "attemptNo",
    }
    assert hosted.run_ids(link) == FIRST_LINK
    json.dumps(link)


def test_a_resumed_run_is_its_own_chain_and_skips_the_attempts_with_a_result() -> None:
    resumed = {**FIRST_LINK, "resumedCount": 2}
    assert hosted.link_id(hosted.Link(**resumed)) == "run_q-r2"
    started = {
        "runId": "run_q",
        "k": 2,
        "cases": CASES,
        "doneAttempts": [{"caseId": "case_1", "attempt": 1}, {"caseId": "case_1", "attempt": 2}],
    }
    link = hosted.after_start(resumed, started)
    seen: list[str] = []
    while link is not None and link["stage"] == "attempt":
        seen.append(hosted.link_id(link))
        link = hosted.after_attempt(link, {"hasPassed": True, "error": None})
    assert seen == ["run_q-r2-c2-a1", "run_q-r2-c2-a2"]
    assert link is not None and hosted.link_id(link) == "run_q-r2-end"
    assert hosted.run_ids(link) == FIRST_LINK


def test_a_resumed_run_with_every_attempt_done_goes_straight_to_its_end() -> None:
    started = {
        "runId": "run_q",
        "k": 1,
        "cases": CASES,
        "doneAttempts": [{"caseId": "case_1", "attempt": 1}, {"caseId": "case_2", "attempt": 1}],
    }
    ended = hosted.after_start({**FIRST_LINK, "resumedCount": 1}, started)
    assert ended is not None and ended["stage"] == "end" and ended["stop"] is None
