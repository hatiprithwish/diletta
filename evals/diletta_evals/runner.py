"""One eval run (M5-2): start it, run every case k times (pass^k), grade each attempt, record it, then reset the
staging host and finish the run.

Attempts run one after another, each in its own conversation with a fresh {case.tag}, each sent once (the backend
refuses a repeat). An attempt the chatbot couldn't answer (the backend's failure ChatbotUnavailable or BudgetRefused)
is recorded as failed with the reason, and the run goes on; a readback the backend refused (a 4xx) is a failed check
of that attempt. Anything else stops the run: a backend ServerError, the backend or the host unreachable, a host
login that fails, a judge that couldn't give a verdict (M5-3: that attempt is recorded failed with why first, so a
case with a rubric never passes ungraded). The run then still resets and ends Failed with why it stopped (the Tests
page shows it), and the error that stopped it is raised (the CLI exits 2: the run couldn't run, which is not the
chatbot failing). The reset (the connection's reset_op) runs once, after the last attempt; a run whose reset didn't
go through can't be Done.
"""

import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from importlib.metadata import version
from typing import TextIO

from pydantic import ValidationError

from diletta_evals.client import EvalApi, EvalApiError
from diletta_evals.constants import (
    RUN_FAILURE_HARNESS_ERROR,
    RUN_FAILURE_HOST_UNAVAILABLE,
    RUN_FAILURE_JUDGE_UNAVAILABLE,
    RUN_FAILURE_SERVER_ERROR,
)
from diletta_evals.graders import (
    JUDGE_UNAVAILABLE_PREFIX,
    GradedAttempt,
    JudgeUnavailable,
    JudgeVerdict,
    ReadbackOutcome,
    failed_attempt,
    grade_attempt,
)
from diletta_evals.hosts.base import HostLogin, HostLoginError
from diletta_evals.tags import fill_case_tag, new_case_tag
from diletta_evals.types import eval_api

HARNESS_VERSION = version("diletta-evals")

# DEV_NOTE: packages/schemas EvalAttemptFailureEnum: the attempt couldn't run because of the chatbot (it can't answer,
# a budget said no), so it fails and the run goes on. Its ServerError is the backend's, and stops the run.
ATTEMPT_REFUSED_FAILURES = frozenset({eval_api.Failure.ChatbotUnavailable, eval_api.Failure.BudgetRefused})


class JudgeUnavailableError(Exception):
    """The pinned judge couldn't give a verdict on an attempt: the run stops (its attempt is already recorded)."""


def stop_reason(error: BaseException | None) -> eval_api.EvalRunFailure | None:
    """Why a run that didn't finish stopped, as the Tests page shows it (packages/schemas EvalRunFailureIntEnum), from
    the error that stopped it (or, when nothing else did, the one that failed its reset). The backend is only blamed
    for what it answered with a 5xx or couldn't answer at all; anything else is the harness's own stop."""
    if error is None:
        return None
    if isinstance(error, JudgeUnavailableError):
        return RUN_FAILURE_JUDGE_UNAVAILABLE
    if isinstance(error, HostLoginError):
        return RUN_FAILURE_HOST_UNAVAILABLE
    if isinstance(error, EvalApiError):
        if error.failure is eval_api.Failure.HostFailed:
            return RUN_FAILURE_HOST_UNAVAILABLE
        if error.is_transient:
            return RUN_FAILURE_SERVER_ERROR
    return RUN_FAILURE_HARNESS_ERROR


@dataclass
class RunSummary:
    run_id: str
    case_count: int = 0
    passed_case_count: int = 0
    has_passed: bool = False
    failed_safety_case_count: int = 0
    cost_usd: str = "0"
    failed_cases: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ConfigTarget:
    config_id: str


@dataclass(frozen=True)
class ChatbotTarget:
    chatbot_id: str


RunTarget = ConfigTarget | ChatbotTarget


class EvalRunner:
    def __init__(self, client: EvalApi, host: HostLogin, out: TextIO = sys.stdout) -> None:
        self._client = client
        self._host = host
        self._out = out

    def run(self, *, target: RunTarget, k: int, trigger: eval_api.Trigger) -> RunSummary:
        """target: the config to run, or a chatbot whose published config the backend picks at the start (M5-5)."""
        self._host.prepare()
        if isinstance(target, ChatbotTarget):
            request = eval_api.CreateEvalRunApiRequest(
                chatbotId=target.chatbot_id, k=k, harnessVersion=HARNESS_VERSION, trigger=trigger
            )
        else:
            request = eval_api.CreateEvalRunApiRequest(
                chatbotConfigId=target.config_id, k=k, harnessVersion=HARNESS_VERSION, trigger=trigger
            )
        started = self._client.start_run(request)
        run_id = started.run.publicId
        self._say(f"Run {run_id}: {len(started.cases)} cases × {k} attempts")

        failed_cases: list[str] = []
        stopped_by: BaseException | None = None
        try:
            for case in started.cases:
                has_case_passed = True
                for attempt in range(1, k + 1):
                    graded = self._run_attempt(run_id, case, attempt)
                    has_case_passed = has_case_passed and graded.has_passed
                    error = graded.grader_output.get("error")
                    self._say(
                        f"  {'PASS' if graded.has_passed else 'FAIL'} {case.name} (attempt {attempt})"
                        + (f": {error}" if error else "")
                    )
                    # DEV_NOTE: After its line is printed, so the CLI shows the attempt that stopped the run
                    if graded.judge_unavailable is not None:
                        raise JudgeUnavailableError(f"{JUDGE_UNAVAILABLE_PREFIX}: {graded.judge_unavailable}")
                if not has_case_passed:
                    failed_cases.append(case.name)
        except BaseException as error:
            stopped_by = error

        # DEV_NOTE: Whatever stopped the attempts, the staging data is put back and the run is ended, so it never stays
        # Running. A reset that fails doesn't fail the results already graded, but the run can't count as Done: the
        # next run would start from data this one left behind. If ending the run fails too, the error that stopped the
        # run is the one raised (the other is printed), so the first cause is never hidden.
        reset_error = self._reset(run_id)
        is_complete = stopped_by is None and reset_error is None
        try:
            finished = self._client.finish(
                run_id,
                eval_api.FinishEvalRunApiRequest(
                    isComplete=is_complete,
                    failure=None if is_complete else stop_reason(stopped_by or reset_error),
                ),
            )
        except Exception as error:
            if stopped_by is not None:
                self._say(f"The run couldn't be ended: {error}")
                raise stopped_by from None
            raise
        if stopped_by is not None:
            raise stopped_by

        summary = RunSummary(
            run_id=run_id,
            case_count=finished.caseCount,
            passed_case_count=finished.passAllKCount,
            has_passed=finished.hasPassed,
            failed_safety_case_count=finished.failedSafetyCaseCount,
            cost_usd=finished.costUsd,
            failed_cases=failed_cases,
        )
        self._say(
            f"Run {run_id} {'passed' if summary.has_passed else 'failed'} ({finished.statusLabel.value}): "
            f"{summary.passed_case_count}/{summary.case_count} cases passed every attempt, ${summary.cost_usd}"
        )
        # The safety hard gate (M5-4): one failed safety case fails the run, however many other cases passed
        if summary.failed_safety_case_count > 0:
            self._say(f"  {summary.failed_safety_case_count} safety case(s) failed: publishing is blocked")
        for name in failed_cases:
            self._say(f"  Failed: {name}")
        return summary

    def _run_attempt(self, run_id: str, case: eval_api.EvalHarnessCase, attempt: int) -> GradedAttempt:
        tag = new_case_tag()
        messages = fill_case_tag(case.input.model_dump(mode="json")["messages"], tag)
        expectations = fill_case_tag(case.expectations.model_dump(mode="json"), tag)
        if not isinstance(expectations, Mapping):
            raise TypeError("A case's expectations are a JSON object")

        try:
            answered = self._client.run_attempt(
                run_id,
                eval_api.RunEvalAttemptApiRequest.model_validate(
                    {"caseId": case.publicId, "attempt": attempt, "messages": messages}
                ),
                self._host.host_token(),
            )
        except EvalApiError as error:
            if error.failure not in ATTEMPT_REFUSED_FAILURES:
                raise
            graded = failed_attempt(f"The attempt didn't run: {error}")
            self._record(run_id, case.publicId, attempt, graded, None)
            return graded

        attempt_json = answered.model_dump(mode="json")

        def read_back(call: Mapping[str, object], readback: Mapping[str, object]) -> ReadbackOutcome:
            try:
                checked = self._client.read_back(
                    run_id,
                    eval_api.EvalReadbackApiRequest.model_validate(
                        {
                            "conversationId": answered.conversationId,
                            "changeRequestId": call["changeRequestId"],
                            "readback": readback,
                        }
                    ),
                    self._host.host_token(),
                )
            except EvalApiError as error:
                # DEV_NOTE: The backend refused this readback (the tool has no readback, the change isn't the run's):
                # a failed check of this attempt, never the end of the run. Unreachable or 5xx (after the client's
                # retries) stops the run.
                if error.is_transient:
                    raise
                return ReadbackOutcome(verdict="unknown", fields=[], reason=f"The readback was refused: {error}")
            return ReadbackOutcome(
                verdict=checked.verdict.value,
                fields=[item.model_dump(mode="json") for item in checked.fields],
                reason=checked.reason,
            )

        def judge(rubric: str) -> JudgeVerdict | JudgeUnavailable:
            try:
                judged = self._client.judge(
                    run_id,
                    eval_api.EvalJudgeApiRequest(conversationId=answered.conversationId, rubric=rubric),
                )
            except EvalApiError as error:
                # DEV_NOTE: Only the judge's own refusal is graded (and stops the run once recorded); any other refusal
                # stops the run as it would at any step
                if error.failure is not eval_api.Failure.JudgeUnavailable:
                    raise
                return JudgeUnavailable(reason=str(error))
            return JudgeVerdict(
                has_passed=judged.hasPassed,
                reason=judged.reason,
                model=judged.model,
                prompt_version=judged.promptVersion,
            )

        graded = grade_attempt(expectations, attempt_json, read_back, judge)
        self._record(run_id, case.publicId, attempt, graded, answered.latencyMs)
        return graded

    def _record(
        self, run_id: str, case_id: str, attempt: int, graded: GradedAttempt, latency_ms: int | None
    ) -> None:
        body = {
            "caseId": case_id,
            "attempt": attempt,
            "hasPassed": graded.has_passed,
            "graderOutput": graded.grader_output,
            "latencyMs": latency_ms,
        }
        try:
            request = eval_api.RecordEvalResultApiRequest.model_validate(body)
        except ValidationError as error:
            # DEV_NOTE: Grading produced an output the contract refuses (a harness bug): the attempt is recorded as
            # failed with why, so the run still has its result
            reason = f"The grader output is invalid: {error.error_count()} error(s), first at {error.errors()[0]['loc']}"
            request = eval_api.RecordEvalResultApiRequest.model_validate(
                {**body, "hasPassed": False, "graderOutput": failed_attempt(reason).grader_output}
            )
        self._client.record_result(run_id, request)

    def _reset(self, run_id: str) -> Exception | None:
        """The connection's reset_op, once; the error (printed) when it didn't go through, None when it did."""
        try:
            reset = self._client.reset(run_id, self._host.host_token())
        except Exception as error:
            self._say(f"The staging reset failed: {error}")
            return error
        self._say("Staging data reset" if reset.isReset else "The connection has no reset op")
        return None

    def _say(self, line: str) -> None:
        self._out.write(f"{line}\n")
        self._out.flush()
