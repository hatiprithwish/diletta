"""The run loop (diletta_evals.runner) against a fake API and host: k attempts per case, tags, readbacks, results,
the reset once after the last attempt, and how the run ends when something stops it."""

import io

import pytest

from diletta_evals import runner as runner_module
from diletta_evals.client import EvalApiError
from diletta_evals.constants import (
    RUN_FAILURE_HARNESS_ERROR,
    RUN_FAILURE_HOST_UNAVAILABLE,
    RUN_FAILURE_JUDGE_UNAVAILABLE,
    RUN_FAILURE_SERVER_ERROR,
)
from diletta_evals.graders import GradedAttempt
from diletta_evals.hosts.base import HostLoginError
from diletta_evals.runner import EvalRunner, JudgeUnavailableError
from diletta_evals.types import eval_api

Failure = eval_api.Failure

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


# DEV_NOTE: The same case with a rubric the judge grades ({case.tag} filled like the rest)
RUBRIC_CASE = {**CASE, "expectations": {**CASE["expectations"], "rubric": "Confirms note {case.tag}"}}


class FakeHost:
    def __init__(self, fail_token_after: int | None = None) -> None:
        self.prepared = 0
        self.tokens = 0
        self._fail_token_after = fail_token_after

    def prepare(self) -> None:
        self.prepared += 1

    def host_token(self) -> str:
        self.tokens += 1
        if self._fail_token_after is not None and self.tokens > self._fail_token_after:
            raise HostLoginError("Test host token mint failed: HTTP 503")
        return "host-token"


class FakeClient:
    def __init__(
        self,
        *,
        refuse_attempt: tuple[int, EvalApiError] | None = None,
        refuse_readback: EvalApiError | None = None,
        refuse_reset: EvalApiError | None = None,
        refuse_finish: EvalApiError | None = None,
        case: dict[str, object] = CASE,
        refuse_judge: EvalApiError | None = None,
    ) -> None:
        self.events: list[str] = []
        # DEV_NOTE: What the runner printed (the CLI's output)
        self.out = io.StringIO()
        self.results: list[eval_api.RecordEvalResultApiRequest] = []
        self.readbacks: list[eval_api.EvalReadbackApiRequest] = []
        self.finish_request: eval_api.FinishEvalRunApiRequest | None = None
        self._refuse_attempt = refuse_attempt
        self._refuse_readback = refuse_readback
        self._refuse_reset = refuse_reset
        self._refuse_finish = refuse_finish
        self._case = case
        self._refuse_judge = refuse_judge
        self.judged: list[eval_api.EvalJudgeApiRequest] = []
        self._tag = ""

    def start_run(self, request: eval_api.CreateEvalRunApiRequest) -> eval_api.CreateEvalRunApiResponse:
        self.events.append("start")
        return eval_api.CreateEvalRunApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "run": {"publicId": "run_1", "k": request.k, "harnessVersion": request.harnessVersion},
                "cases": [self._case],
            }
        )

    def run_attempt(
        self, run_id: str, request: eval_api.RunEvalAttemptApiRequest, host_token: str
    ) -> eval_api.RunEvalAttemptApiResponse:
        self.events.append(f"attempt {request.attempt}")
        if self._refuse_attempt and request.attempt == self._refuse_attempt[0]:
            raise self._refuse_attempt[1]
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
                        "wasApprovalRequired": True,
                    }
                ],
                "latencyMs": 10,
            }
        )

    def read_back(
        self, run_id: str, request: eval_api.EvalReadbackApiRequest, host_token: str
    ) -> eval_api.EvalReadbackApiResponse:
        self.readbacks.append(request)
        if self._refuse_readback is not None:
            raise self._refuse_readback
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

    def judge(self, run_id: str, request: eval_api.EvalJudgeApiRequest) -> eval_api.EvalJudgeApiResponse:
        self.events.append("judge")
        self.judged.append(request)
        if self._refuse_judge is not None:
            raise self._refuse_judge
        return eval_api.EvalJudgeApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "hasPassed": True,
                "reason": "Confirms the note.",
                "provider": "anthropic",
                "model": "claude-sonnet-5-5",
                "promptVersion": 1,
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
        if self._refuse_reset is not None:
            raise self._refuse_reset
        return eval_api.ResetEvalRunApiResponse(isSuccess=True, message="ok", isReset=True)

    def finish(
        self, run_id: str, request: eval_api.FinishEvalRunApiRequest
    ) -> eval_api.FinishEvalRunApiResponse:
        self.events.append("finish")
        self.finish_request = request
        if self._refuse_finish is not None:
            raise self._refuse_finish
        passed = sum(1 for result in self.results if result.hasPassed)
        return eval_api.FinishEvalRunApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "status": 3 if request.isComplete else 4,
                "statusLabel": "Done" if request.isComplete else "Failed",
                "caseCount": 1,
                "passAllKCount": 1 if passed == len(self.results) else 0,
                "hasPassed": request.isComplete and passed == len(self.results),
                "failedSafetyCaseCount": 0,
                "costUsd": "0.010000",
            }
        )


def run(client: FakeClient, host: FakeHost | None = None, k: int = 3):
    return EvalRunner(client, host or FakeHost(), out=client.out).run(
        config_id="cfg_1", k=k, trigger=eval_api.Trigger.number_2
    )


def test_runs_every_attempt_with_its_own_tag_then_resets_once_and_finishes() -> None:
    client, host = FakeClient(), FakeHost()
    summary = run(client, host)
    assert summary.has_passed
    assert summary.failed_cases == []
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


def test_an_attempt_the_chatbot_couldnt_answer_fails_and_the_run_goes_on() -> None:
    client = FakeClient(
        refuse_attempt=(2, EvalApiError(503, "The chatbot can't answer", Failure.ChatbotUnavailable))
    )
    summary = run(client)
    assert not summary.has_passed
    assert summary.failed_cases == ["Updates Alpha"]
    refused = client.results[1]
    assert not refused.hasPassed
    assert refused.graderOutput.error is not None and "ChatbotUnavailable" in refused.graderOutput.error.root
    assert client.finish_request is not None and client.finish_request.isComplete


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        # DEV_NOTE: A backend fault is never read as the chatbot failing: it stops the run (exit 2), and the page blames
        # the backend only for what it failed to answer; a refusal it answered (4xx) is the harness's own stop
        (EvalApiError(0, "The backend is unreachable"), RUN_FAILURE_SERVER_ERROR),
        (EvalApiError(500, "Server error", Failure.ServerError), RUN_FAILURE_SERVER_ERROR),
        (EvalApiError(409, "This eval attempt already ran", Failure.Duplicate), RUN_FAILURE_HARNESS_ERROR),
    ],
)
def test_anything_else_stops_the_run_which_still_resets_and_ends_failed(
    error: EvalApiError, reason: eval_api.EvalRunFailure
) -> None:
    client = FakeClient(refuse_attempt=(2, error))
    with pytest.raises(EvalApiError) as raised:
        run(client)
    assert raised.value is error
    assert client.events[-2:] == ["reset", "finish"]
    assert client.finish_request is not None and not client.finish_request.isComplete
    assert client.finish_request.failure is reason


def test_a_refused_readback_is_a_failed_check_not_the_end_of_the_run() -> None:
    client = FakeClient(refuse_readback=EvalApiError(400, "The tool has no readback", Failure.Invalid))
    summary = run(client, k=1)
    assert not summary.has_passed
    [result] = client.results
    readback = next(check for check in result.graderOutput.checks if check.kind.value == "readback")
    assert not readback.hasPassed
    assert readback.detail is not None and "refused" in readback.detail.root
    assert client.finish_request is not None and client.finish_request.isComplete


def test_an_unreachable_readback_stops_the_run() -> None:
    client = FakeClient(refuse_readback=EvalApiError(0, "The backend is unreachable"))
    with pytest.raises(EvalApiError):
        run(client, k=1)
    assert client.finish_request is not None and not client.finish_request.isComplete


@pytest.mark.parametrize(
    ("fail", "reason"),
    [
        ("host refused the reset", RUN_FAILURE_HOST_UNAVAILABLE),
        ("host login", RUN_FAILURE_HOST_UNAVAILABLE),
        ("backend failed the reset", RUN_FAILURE_SERVER_ERROR),
    ],
)
def test_a_failed_reset_still_ends_the_run_never_done_with_its_own_reason(
    fail: str, reason: eval_api.EvalRunFailure
) -> None:
    if fail == "host refused the reset":
        client, host = FakeClient(refuse_reset=EvalApiError(502, "The host reset failed", Failure.HostFailed)), None
    elif fail == "host login":
        # DEV_NOTE: Every attempt and readback gets its token; the reset's own token can't be minted
        client, host = FakeClient(), FakeHost(fail_token_after=2)
    else:
        client, host = FakeClient(refuse_reset=EvalApiError(500, "Server error", Failure.ServerError)), None
    summary = run(client, host, k=1)
    assert client.events[-1] == "finish"
    assert client.finish_request is not None and not client.finish_request.isComplete
    assert client.finish_request.failure is reason
    assert not summary.has_passed


def test_a_finish_that_fails_after_a_stop_never_hides_what_stopped_the_run() -> None:
    stop = EvalApiError(0, "The backend is unreachable")
    client = FakeClient(refuse_attempt=(1, stop), refuse_finish=EvalApiError(0, "Still unreachable"))
    with pytest.raises(EvalApiError) as raised:
        run(client, k=1)
    assert raised.value is stop


def test_a_grader_output_the_contract_refuses_is_recorded_as_a_failed_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def too_long(*_args: object) -> GradedAttempt:
        check = {"kind": "rubric", "hasPassed": True, "label": "x" * 500, "detail": None}
        return GradedAttempt(has_passed=True, grader_output={"schemaVersion": 1, "checks": [check], "error": None})

    monkeypatch.setattr(runner_module, "grade_attempt", too_long)
    client = FakeClient()
    summary = run(client, k=1)
    [result] = client.results
    assert not result.hasPassed
    assert result.graderOutput.error is not None and "invalid" in result.graderOutput.error.root
    assert not summary.has_passed


def test_a_case_with_a_rubric_is_judged_on_its_own_conversation_with_the_tag_filled() -> None:
    client = FakeClient(case=RUBRIC_CASE)
    summary = run(client, k=2)
    assert summary.has_passed
    assert [request.conversationId for request in client.judged] == ["conv_1", "conv_2"]
    tags = [request.rubric.removeprefix("Confirms note ") for request in client.judged]
    assert len(set(tags)) == 2 and all("{case.tag}" not in tag for tag in tags)
    judge_checks = [
        check for result in client.results for check in result.graderOutput.checks if check.kind.value == "judge"
    ]
    assert [check.hasPassed for check in judge_checks] == [True, True]
    assert client.finish_request is not None and client.finish_request.isComplete
    assert client.finish_request.failure is None


def test_an_unreachable_judge_records_the_attempt_failed_then_stops_the_run_with_why() -> None:
    refusal = EvalApiError(503, "The judge model couldn't be reached (claude-sonnet-5-5)", Failure.JudgeUnavailable)
    client = FakeClient(case=RUBRIC_CASE, refuse_judge=refusal)
    with pytest.raises(JudgeUnavailableError) as raised:
        run(client, k=3)
    assert "The judge couldn't be reached" in str(raised.value)
    assert "claude-sonnet-5-5" in str(raised.value)
    # DEV_NOTE: The judge is asked once (the backend already retried the model), the attempt is recorded failed with
    # why, and no later attempt runs
    assert client.events == ["start", "attempt 1", "judge", "result 1", "reset", "finish"]
    # DEV_NOTE: The attempt that stopped the run is printed before the run ends
    assert "FAIL Updates Alpha (attempt 1): The judge couldn't be reached: HTTP 503" in client.out.getvalue()
    [result] = client.results
    assert not result.hasPassed
    assert result.graderOutput.error is not None
    assert result.graderOutput.error.root.startswith("The judge couldn't be reached: HTTP 503")
    assert client.finish_request is not None and not client.finish_request.isComplete
    assert client.finish_request.failure is RUN_FAILURE_JUDGE_UNAVAILABLE


def test_any_other_judge_refusal_stops_the_run_with_its_own_reason() -> None:
    refused = FakeClient(case=RUBRIC_CASE, refuse_judge=EvalApiError(404, "Not this run's", Failure.NotFound))
    with pytest.raises(EvalApiError):
        run(refused, k=1)
    assert refused.results == []
    assert refused.finish_request is not None and refused.finish_request.failure is RUN_FAILURE_HARNESS_ERROR

    failed = FakeClient(case=RUBRIC_CASE, refuse_judge=EvalApiError(500, "Server error", Failure.ServerError))
    with pytest.raises(EvalApiError):
        run(failed, k=1)
    assert failed.finish_request is not None and failed.finish_request.failure is RUN_FAILURE_SERVER_ERROR


def test_a_stop_of_the_harness_own_is_never_blamed_on_the_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_args: object) -> GradedAttempt:
        raise TypeError("a harness bug")

    monkeypatch.setattr(runner_module, "grade_attempt", broken)
    client = FakeClient()
    with pytest.raises(TypeError):
        run(client, k=1)
    assert client.events[-2:] == ["reset", "finish"]
    assert client.finish_request is not None and client.finish_request.failure is RUN_FAILURE_HARNESS_ERROR

