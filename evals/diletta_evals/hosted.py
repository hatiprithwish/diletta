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

The steps run in a chain of Workflow instances (ADR 0007 › Chained instances), each one fresh invocation with its own
subrequest budget (Workers Free: 50 to the internet per invocation, which one long instance runs out of): the backend
creates the first (stage "start", id = the run's public id), and each link creates the next one, named by link_id so
a repeated create finds it instead of running a step twice. A link's params carry ids, cases, k, where it is, the
attempts already done and a stop, never a sign-in or a token.

  start              start                          → the first attempt, or end when there are no cases
  attempt c{i} a{j}  one attempt                    → the next attempt (j < k) or case, or end; a stop → end
  end                reset, then finish             (a stop at start ends there: the run never left Queued)

A resumed run (ADR 0007 › Resume) is the same chain again, named <run>-r<n>…, which skips every attempt the backend
says already has a result (start's doneAttempts).
"""

from collections.abc import Mapping
from typing import Any, Literal, TypedDict

from diletta_evals.client import EvalApi, EvalApiError
from diletta_evals.config import ConfigError, ERegisterSettings, HarnessConfig, HostKind, TestHostSettings
from diletta_evals.constants import RUN_FAILURE_HARNESS_ERROR
from diletta_evals.graders import JUDGE_UNAVAILABLE_PREFIX, failed_attempt
from diletta_evals.hosts.base import HostLogin
from diletta_evals.runner import EvalRunner, JudgeUnavailableError, QueuedRunTarget, stop_reason
from diletta_evals.types import eval_api

Json = dict[str, Any]

INTERRUPTED_ATTEMPT = "The attempt was interrupted and is not run again"

Stage = Literal["start", "attempt", "end"]


class Link(TypedDict, total=False):
    """One chained instance's params. The backend's first link holds the two ids only (stage defaults to start)."""

    companyPublicId: str
    runPublicId: str
    stage: Stage
    k: int
    cases: list[Json]
    caseIndex: int
    attemptNo: int
    resumedCount: int
    done: list[str]
    stop: Json | None


def _done_key(case_id: str, attempt_no: int) -> str:
    return f"{case_id}#{attempt_no}"


def run_ids(link: Mapping[str, Any]) -> Json:
    """What the backend's binding takes (ZEvalRunWorkflowParams is strict): the two public ids only."""
    return {"companyPublicId": str(link["companyPublicId"]), "runPublicId": str(link["runPublicId"])}


def stage_of(link: Mapping[str, Any]) -> Stage:
    stage = link.get("stage", "start")
    if stage not in ("start", "attempt", "end"):
        raise ConfigError(f"Unknown chain stage {stage!r}")
    return stage


def link_id(link: Link) -> str:
    """The instance id of a link: the first is the run's public id (the backend's), so a run starts once; the others
    are named by where they are, so a link created twice is found, not run twice."""
    resumed_count = int(link.get("resumedCount", 0))
    run_id = link["runPublicId"] if resumed_count == 0 else f"{link['runPublicId']}-r{resumed_count}"
    stage = stage_of(link)
    if stage == "start":
        return run_id
    if stage == "end":
        return f"{run_id}-end"
    return f"{run_id}-c{link['caseIndex'] + 1}-a{link['attemptNo']}"


def _base(link: Mapping[str, Any]) -> Link:
    ids = run_ids(link)
    return Link(
        companyPublicId=ids["companyPublicId"],
        runPublicId=ids["runPublicId"],
        resumedCount=int(link.get("resumedCount", 0)),
    )


def _end(link: Mapping[str, Any], stop: Json | None) -> Link:
    return Link(**_base(link), stage="end", stop=stop)


def _next_attempt(
    link: Mapping[str, Any], k: int, cases: list[Json], done: list[str], case_index: int, attempt_no: int
) -> Link:
    """The first attempt from (case_index, attempt_no) on that has no result yet, else end."""
    done_keys = set(done)
    while case_index < len(cases):
        if attempt_no > k:
            case_index, attempt_no = case_index + 1, 1
            continue
        if _done_key(str(cases[case_index]["publicId"]), attempt_no) not in done_keys:
            return Link(
                **_base(link),
                stage="attempt",
                k=k,
                cases=cases,
                done=done,
                caseIndex=case_index,
                attemptNo=attempt_no,
            )
        attempt_no += 1
    return _end(link, None)


def after_start(link: Mapping[str, Any], started: Json) -> Link | None:
    """The link after start: None when start stopped (the run is failed while still Queued, nothing to reset)."""
    if "stop" in started:
        return None
    cases: list[Json] = list(started["cases"])
    k = int(started["k"])
    done = [_done_key(str(item["caseId"]), int(item["attempt"])) for item in started.get("doneAttempts", [])]
    if not cases or k < 1:
        return _end(link, None)
    return _next_attempt(link, k, cases, done, 0, 1)


def after_attempt(link: Mapping[str, Any], answer: Json) -> Link:
    """The link after an attempt: the next attempt of this case, the next case, or end (at once on a stop)."""
    if "stop" in answer:
        return _end(link, answer["stop"])
    return _next_attempt(
        link,
        int(link["k"]),
        list(link["cases"]),
        list(link.get("done", [])),
        int(link["caseIndex"]),
        int(link["attemptNo"]) + 1,
    )


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
        "doneAttempts": [attempt.model_dump(mode="json") for attempt in started.doneAttempts],
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
