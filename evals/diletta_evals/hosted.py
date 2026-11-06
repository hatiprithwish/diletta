"""The hosted runner's steps (M7-9, ADR 0007): one run the dashboard queued, cut into the steps of a Cloudflare
Workflow (apps/eval-runner) so each attempt is durable. Each step is the CLI's own code (EvalRunner) and answers
plain JSON, because a Workflow persists what a step returns: case ids, verdicts and why a run stopped, never the
test sign-in, a host token or an eval JWT.

  start    signs the host test user in and starts the queued run (POST /eval/runs {runId}): its k and cases
  attempt  one attempt of one case, graded and recorded; an attempt a replayed step finds already started (409
           Duplicate) is recorded failed as interrupted, never run twice
  reset    the connection's reset_op, once
  finish   Done when nothing stopped the run and the reset went through, else Failed with why

A step never raises: what would stop the CLI's run comes back as {"stop": {"failure", "message"}}, so the Workflow
still resets and finishes the run.
"""

from collections.abc import Mapping
from typing import Any

from diletta_evals.client import EvalApi, EvalApiError
from diletta_evals.config import ConfigError, ERegisterSettings, HarnessConfig, HostKind, TestHostSettings
from diletta_evals.constants import RUN_FAILURE_HARNESS_ERROR
from diletta_evals.graders import JUDGE_UNAVAILABLE_PREFIX, failed_attempt
from diletta_evals.hosts.base import HostLogin
from diletta_evals.runner import EvalRunner, JudgeUnavailableError, QueuedRunTarget, stop_reason
from diletta_evals.types import eval_api

Json = dict[str, Any]

INTERRUPTED_ATTEMPT = "The attempt was interrupted and is not run again"


def harness_config(run_login: Mapping[str, Any], *, api_url: str, private_jwk: dict[str, object]) -> HarnessConfig:
    """The CLI's settings for one run, from the backend's EvalRunLogin (the company, its staging connection and the
    decrypted test sign-in) and the runner's own api_url and eval key."""
    login = run_login.get("login")
    if not isinstance(login, Mapping):
        raise ConfigError("The run's test sign-in is missing")
    try:
        kind = HostKind(str(login["kind"]))
        host_user = str(login["hostUser"])
        test_host = (
            TestHostSettings(issuer=str(login["issuer"]).rstrip("/"), admin_secret=str(login["adminSecret"]))
            if kind is HostKind.TEST_HOST
            else None
        )
        eregister = (
            ERegisterSettings(
                firebase_api_key=str(login["firebaseApiKey"]),
                email=str(login["email"]),
                password=str(login["password"]),
            )
            if kind is HostKind.EREGISTER
            else None
        )
        return HarnessConfig(
            api_url=api_url.rstrip("/"),
            private_jwk=private_jwk,
            company_id=str(run_login["companyPublicId"]),
            connection_id=str(run_login["connectionPublicId"]),
            host_user=host_user,
            host_kind=kind,
            test_host=test_host,
            eregister=eregister,
        )
    except (KeyError, ValueError) as error:
        # DEV_NOTE: Names the field, never its value
        raise ConfigError(f"The run's test sign-in can't be read: {type(error).__name__} {error.args[:1]}") from error


def _stop(error: BaseException) -> Json:
    failure = stop_reason(error) or RUN_FAILURE_HARNESS_ERROR
    return {"failure": failure.value, "message": f"{type(error).__name__}: {error}"[:500]}


async def start(runner: EvalRunner, host: HostLogin, run_id: str) -> Json:
    """The queued run, started: {"runId", "k", "cases"} (cases as the backend sent them), or {"stop"}."""
    try:
        await host.prepare()
        started = await runner.start(QueuedRunTarget(run_id=run_id))
    except Exception as error:
        return {"stop": _stop(error)}
    return {
        "runId": started.run.publicId,
        "k": started.run.k,
        "cases": [case.model_dump(mode="json") for case in started.cases],
    }


async def attempt(runner: EvalRunner, client: EvalApi, run_id: str, case: Json, attempt_no: int) -> Json:
    """One attempt: {"hasPassed", "error"} and, when the run must stop after it, {"stop"}."""
    harness_case = eval_api.EvalHarnessCase.model_validate(case)
    try:
        graded = await runner.run_attempt(run_id, harness_case, attempt_no)
    except EvalApiError as error:
        if error.failure is not eval_api.Failure.Duplicate:
            return {"hasPassed": False, "error": None, "stop": _stop(error)}
        # DEV_NOTE: A replayed step: this attempt started before (its turn may have run), so it's recorded failed and
        # never sent again. A result already there (the first try got that far) is the one that counts.
        graded = failed_attempt(INTERRUPTED_ATTEMPT)
        try:
            await runner.record(run_id, harness_case.publicId, attempt_no, graded, None)
        except EvalApiError as record_error:
            if record_error.failure is not eval_api.Failure.Duplicate:
                return {"hasPassed": False, "error": INTERRUPTED_ATTEMPT, "stop": _stop(record_error)}
        return {"hasPassed": False, "error": INTERRUPTED_ATTEMPT}
    except Exception as error:
        return {"hasPassed": False, "error": None, "stop": _stop(error)}

    error_text = graded.grader_output.get("error")
    answer: Json = {"hasPassed": graded.has_passed, "error": error_text if isinstance(error_text, str) else None}
    if graded.judge_unavailable is not None:
        answer["stop"] = _stop(JudgeUnavailableError(f"{JUDGE_UNAVAILABLE_PREFIX}: {graded.judge_unavailable}"))
    return answer


async def reset(runner: EvalRunner, run_id: str) -> Json:
    """{"isReset": True}, or {"stop"} with why the reset didn't go through (the run then can't be Done)."""
    reset_error = await runner.reset(run_id)
    return {"isReset": True} if reset_error is None else {"isReset": False, "stop": _stop(reset_error)}


async def finish(client: EvalApi, run_id: str, stop: Mapping[str, Any] | None) -> Json:
    """Ends the run: Done when stop is None, else Failed with stop's failure. {"status", "hasPassed"} or {"stop"}."""
    is_complete = stop is None
    request = eval_api.FinishEvalRunApiRequest(
        isComplete=is_complete,
        failure=None if stop is None else eval_api.EvalRunFailure(stop["failure"]),
    )
    try:
        finished = await client.finish(run_id, request)
    except Exception as error:
        return {"stop": _stop(error)}
    return {"status": finished.statusLabel.value, "hasPassed": finished.hasPassed}
