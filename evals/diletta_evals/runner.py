"""One eval run (M5-2): start it, run every case k times (pass^k), grade each attempt, record it, then reset the
staging host and finish the run.

Attempts run one after another, each in its own conversation with a fresh {case.tag}. An attempt the backend refused
(the chatbot couldn't answer, a budget said no) is recorded as failed with the reason, and the run goes on. Anything
else that stops the run (the backend or host unreachable, a refused result) ends it Failed; the reset still runs
first. The reset (the connection's reset_op) runs once, after the last attempt.
"""

import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from importlib.metadata import version
from typing import TextIO

from diletta_evals.client import EvalApi, EvalApiError
from diletta_evals.graders import GradedAttempt, ReadbackOutcome, failed_attempt, grade_attempt
from diletta_evals.hosts.base import HostLogin
from diletta_evals.tags import fill_case_tag, new_case_tag
from diletta_evals.types import eval_api

HARNESS_VERSION = version("diletta-evals")

# The backend's answer to an attempt it couldn't start (EVAL_ATTEMPT_FAILURE_HTTP_STATUS_MAP): the attempt fails,
# the run goes on
ATTEMPT_REFUSED_STATUSES = frozenset({500, 503})


@dataclass
class RunSummary:
    run_id: str
    case_count: int = 0
    passed_case_count: int = 0
    has_passed: bool = False
    cost_usd: str = "0"
    failed_cases: list[str] = field(default_factory=list)


class EvalRunner:
    def __init__(self, client: EvalApi, host: HostLogin, out: TextIO = sys.stdout) -> None:
        self._client = client
        self._host = host
        self._out = out

    def run(self, *, config_id: str, k: int, trigger: eval_api.Trigger) -> RunSummary:
        self._host.prepare()
        started = self._client.start_run(
            eval_api.CreateEvalRunApiRequest(
                chatbotConfigId=config_id, k=k, harnessVersion=HARNESS_VERSION, trigger=trigger
            )
        )
        run_id = started.run.publicId
        self._say(f"Run {run_id}: {len(started.cases)} cases × {k} attempts")

        is_complete = False
        try:
            for case in started.cases:
                for attempt in range(1, k + 1):
                    graded = self._run_attempt(run_id, case, attempt)
                    error = graded.grader_output.get("error")
                    self._say(
                        f"  {'PASS' if graded.has_passed else 'FAIL'} {case.name} (attempt {attempt})"
                        + (f": {error}" if error else "")
                    )
            is_complete = True
        finally:
            # DEV_NOTE: A failed reset doesn't fail the results already graded, but the run can't count as Done:
            # the next run would start from data this one left behind
            try:
                self._reset(run_id)
            except EvalApiError as error:
                self._say(f"The staging reset failed: {error}")
                is_complete = False
            finished = self._client.finish(run_id, eval_api.FinishEvalRunApiRequest(isComplete=is_complete))

        summary = RunSummary(
            run_id=run_id,
            case_count=finished.caseCount,
            passed_case_count=finished.passAllKCount,
            has_passed=finished.hasPassed,
            cost_usd=finished.costUsd,
        )
        self._say(
            f"Run {run_id} {'passed' if summary.has_passed else 'failed'}: "
            f"{summary.passed_case_count}/{summary.case_count} cases passed every attempt, ${summary.cost_usd}"
        )
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
            if error.status not in ATTEMPT_REFUSED_STATUSES:
                raise
            graded = failed_attempt(f"The attempt didn't run: {error}")
            self._record(run_id, case.publicId, attempt, graded, None)
            return graded

        attempt_json = answered.model_dump(mode="json")

        def read_back(call: Mapping[str, object], readback: Mapping[str, object]) -> ReadbackOutcome:
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
            return ReadbackOutcome(
                verdict=checked.verdict.value,
                fields=[item.model_dump(mode="json") for item in checked.fields],
                reason=checked.reason,
            )

        graded = grade_attempt(expectations, attempt_json, read_back)
        self._record(run_id, case.publicId, attempt, graded, answered.latencyMs)
        return graded

    def _record(
        self, run_id: str, case_id: str, attempt: int, graded: GradedAttempt, latency_ms: int | None
    ) -> None:
        self._client.record_result(
            run_id,
            eval_api.RecordEvalResultApiRequest.model_validate(
                {
                    "caseId": case_id,
                    "attempt": attempt,
                    "hasPassed": graded.has_passed,
                    "graderOutput": graded.grader_output,
                    "latencyMs": latency_ms,
                }
            ),
        )

    def _reset(self, run_id: str) -> None:
        reset = self._client.reset(run_id, self._host.host_token())
        self._say("Staging data reset" if reset.isReset else "The connection has no reset op")

    def _say(self, line: str) -> None:
        self._out.write(f"{line}\n")
        self._out.flush()
