"""The run loop (diletta_evals.runner) against a fake API and host: k attempts per case, tags, readbacks, results,
the reset after every attempt, and how the run ends."""

import io

import pytest

from diletta_evals.client import EvalApiError
from diletta_evals.runner import EvalRunner
from diletta_evals.types import eval_api

CASE = {
    "publicId": "case_1",
    "name": "Updates Alpha",
    "isSafety": False,
    "input": {"schemaVersion": 1, "messages": [{"role": "user", "text": "Set Alpha to 300 ({case.tag})"}]},
    "expectations": {
        "schemaVersion": 2,
        "rubric": None,
        "rules": [{"kind": "contains", "text": "{case.tag}"}],
        "toolCalls": [{"toolName": "update_record", "args": {"note": "{case.tag}"}}],
        "forbiddenTools": [],
        "readbacks": [{"toolName": "update_record", "expect": {"note": "{case.tag}"}}],
    },
}


class FakeHost:
    def __init__(self) -> None:
        self.prepared = 0

    def prepare(self) -> None:
        self.prepared += 1

    def host_token(self) -> str:
        return "host-token"


class FakeClient:
    def __init__(self, refuse_attempt: int | None = None, fail_attempt: int | None = None) -> None:
        self.events: list[str] = []
        self.results: list[eval_api.RecordEvalResultApiRequest] = []
        self.readbacks: list[eval_api.EvalReadbackApiRequest] = []
        self.finish_request: eval_api.FinishEvalRunApiRequest | None = None
        self._refuse_attempt = refuse_attempt
        self._fail_attempt = fail_attempt
        self._tag = ""

    def start_run(self, request: eval_api.CreateEvalRunApiRequest) -> eval_api.CreateEvalRunApiResponse:
        self.events.append("start")
        return eval_api.CreateEvalRunApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "run": {"publicId": "run_1", "k": request.k, "harnessVersion": request.harnessVersion},
                "cases": [CASE],
            }
        )

    def run_attempt(
        self, run_id: str, request: eval_api.RunEvalAttemptApiRequest, host_token: str
    ) -> eval_api.RunEvalAttemptApiResponse:
        self.events.append(f"attempt {request.attempt}")
        if request.attempt == self._refuse_attempt:
            raise EvalApiError(503, "The chatbot can't answer", "ChatbotUnavailable")
        if request.attempt == self._fail_attempt:
            raise EvalApiError(0, "The backend is unreachable")
        text = request.messages[0].text
        assert "{case.tag}" not in text
        self._tag = text.removeprefix("Set Alpha to 300 (").removesuffix(")")
        return eval_api.RunEvalAttemptApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "conversationId": f"conv_{request.attempt}",
                "turnStatus": "completed",
                "reply": f"Saved note {self._tag}.",
                "toolCalls": [
                    {
                        "toolCallId": "t1",
                        "toolName": "update_record",
                        "args": {"note": self._tag},
                        "status": "verified",
                        "changeRequestId": "cr_1",
                    }
                ],
                "latencyMs": 10,
            }
        )

    def read_back(
        self, run_id: str, request: eval_api.EvalReadbackApiRequest, host_token: str
    ) -> eval_api.EvalReadbackApiResponse:
        self.readbacks.append(request)
        return eval_api.EvalReadbackApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "verdict": "matches",
                "fields": [
                    {
                        "name": "note",
                        "isMatch": True,
                        "expected": self._tag,
                        "found": self._tag,
                        "isFound": True,
                    }
                ],
                "reason": None,
            }
        )

    def record_result(
        self, run_id: str, request: eval_api.RecordEvalResultApiRequest
    ) -> eval_api.RecordEvalResultApiResponse:
        self.events.append(f"result {request.attempt}")
        self.results.append(request)
        return eval_api.RecordEvalResultApiResponse(isSuccess=True, message="ok")

    def reset(self, run_id: str, host_token: str) -> eval_api.ResetEvalRunApiResponse:
        self.events.append("reset")
        return eval_api.ResetEvalRunApiResponse(isSuccess=True, message="ok", isReset=True)

    def finish(
        self, run_id: str, request: eval_api.FinishEvalRunApiRequest
    ) -> eval_api.FinishEvalRunApiResponse:
        self.events.append("finish")
        self.finish_request = request
        passed = sum(1 for result in self.results if result.hasPassed)
        return eval_api.FinishEvalRunApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "status": 3 if request.isComplete else 4,
                "caseCount": 1,
                "passAllKCount": 1 if passed == len(self.results) else 0,
                "hasPassed": request.isComplete and passed == len(self.results),
                "costUsd": "0.010000",
            }
        )


def runner_for(client: FakeClient, host: FakeHost) -> EvalRunner:
    return EvalRunner(client, host, out=io.StringIO())


def test_runs_every_attempt_with_its_own_tag_then_resets_and_finishes() -> None:
    client, host = FakeClient(), FakeHost()
    summary = runner_for(client, host).run(config_id="cfg_1", k=3, trigger=eval_api.Trigger.number_2)
    assert summary.has_passed
    assert host.prepared == 1
    assert client.events == [
        "start",
        "attempt 1",
        "result 1",
        "attempt 2",
        "result 2",
        "attempt 3",
        "result 3",
        "reset",
        "finish",
    ]
    assert all(result.hasPassed for result in client.results)
    # DEV_NOTE: The readback's expect carries the attempt's own tag
    notes = [request.readback.expect["note"] for request in client.readbacks]
    assert len({note.root for note in notes if note is not None}) == 3


def test_an_attempt_the_backend_refused_fails_and_the_run_goes_on() -> None:
    client = FakeClient(refuse_attempt=2)
    summary = runner_for(client, FakeHost()).run(config_id="cfg_1", k=3, trigger=eval_api.Trigger.number_2)
    assert not summary.has_passed
    refused = client.results[1]
    assert not refused.hasPassed
    assert refused.graderOutput.error is not None and "ChatbotUnavailable" in refused.graderOutput.error.root
    assert client.finish_request is not None and client.finish_request.isComplete


def test_a_run_that_stops_still_resets_and_ends_failed() -> None:
    client = FakeClient(fail_attempt=2)
    with pytest.raises(EvalApiError):
        runner_for(client, FakeHost()).run(config_id="cfg_1", k=3, trigger=eval_api.Trigger.number_2)
    assert client.events[-2:] == ["reset", "finish"]
    assert client.finish_request is not None and not client.finish_request.isComplete
