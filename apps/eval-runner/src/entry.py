"""The hosted eval runner (M7-9, ADR 0007): the runs the dashboard queued, as a chain of Workflow instances.

One instance per link (diletta_evals.hosted: start, one attempt, end), because a Workflow runs its steps in one
invocation and a Workers Free invocation may make only 50 subrequests to the internet: a run of any size never runs out,
each attempt has a fresh budget. The backend creates the first link (id = the run's public id, params
{companyPublicId, runPublicId}); each link runs its step, then creates the next one in a "next" step. Link ids are
fixed by where they are (hosted.link_id), so a "next" step that's repeated finds the instance it already created.

Each step is the CLI's own code (diletta_evals.hosted) and returns plain JSON: Workflows persist step results and
instance params, so neither ever holds the test sign-in, a host token or an eval JWT. A step that needs the host reads
the sign-in again over the BACKEND binding (EvalRunnerEntrypoint.getRunLogin) and signs in for itself, in isolate
memory. Backend calls go over that binding too (binding_transport), off the internet budget.

Attempt steps never retry (an attempt runs a chatbot turn and writes to the host: sent once, as the CLI does); a step
replayed after an eviction is recorded as interrupted by hosted.attempt. A stop skips to the end link, which still
resets and finishes the run; a run that couldn't start is failed through the binding (failQueuedRun) with the stop it
hit. A chain that breaks anyway (a "next" that never ran) leaves the run Running until the next Run press fails it
(EVAL_RUN_RUNNING_STALE_MINUTES).
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from workers import Response, WorkerEntrypoint, WorkflowEntrypoint

from binding_transport import BindingTransport
from diletta_evals import hosted
from diletta_evals.client import EvalApiClient
from diletta_evals.config import ConfigError, load_private_jwk_from
from diletta_evals.constants import RUN_FAILURE_HARNESS_ERROR
from diletta_evals.hosts import host_login_for
from diletta_evals.runner import EvalRunner
from webcrypto_jwt import WebCryptoSigner

# DEV_NOTE: Sent once: Workflows would otherwise retry a failed step, and a retried attempt is a second chatbot turn
SEND_ONCE = {"retries": {"limit": 0, "delay": "1 second"}}
# DEV_NOTE: A reset, a finish, the next link and the binding calls are safe to repeat (the client also retries a reset)
SAFE_TO_REPEAT = {"retries": {"limit": 2, "delay": "10 seconds", "backoff": "linear"}}

Json = dict[str, Any]


def _plain(value: Any) -> Any:
    """A JS answer over RPC as plain Python JSON (nested JsProxy dicts included)."""
    if hasattr(value, "to_py"):
        value = value.to_py()
    return json.loads(json.dumps(value))


def _stop_of(error: BaseException) -> Json:
    return {"failure": RUN_FAILURE_HARNESS_ERROR.value, "message": f"{type(error).__name__}: {error}"[:500]}


def _log_stop(run_id: str, stop: Json | None) -> None:
    # DEV_NOTE: Why a run stopped, in Workers Logs (the run page shows its failure; the message names a field, an HTTP
    # status or Firebase's reason, never a value)
    if stop is not None:
        print(f"Run {run_id} stopped: {stop.get('message')}")


class EvalRunWorkflow(WorkflowEntrypoint):
    async def run(self, event, step):
        link: Json = _plain(event["payload"])
        ids = hosted.run_ids(link)
        run_id = ids["runPublicId"]
        stage = hosted.stage_of(link)

        if stage == "start":

            @step.do("start", config=SEND_ONCE)
            async def start() -> Json:
                return await self._with_runner(ids, lambda runner, client, host: hosted.start(runner, host, run_id))

            started = await start()
            following = hosted.after_start(link, started)
            if following is None:
                _log_stop(run_id, started["stop"])
                await self._fail_queued(step, {**ids, "failure": started["stop"]["failure"]})
                return {"runPublicId": run_id, "stop": started["stop"]}
            await self._next(step, following)
            return {"runPublicId": run_id, "k": started["k"], "caseCount": len(started["cases"])}

        if stage == "attempt":
            case = link["cases"][int(link["caseIndex"])]
            attempt_no = int(link["attemptNo"])

            @step.do("attempt", config=SEND_ONCE)
            async def attempt() -> Json:
                return await self._with_runner(
                    ids,
                    lambda runner, client, host: hosted.attempt(runner, client, run_id, case, attempt_no),
                )

            answer = await attempt()
            await self._next(step, hosted.after_attempt(link, answer))
            return {"runPublicId": run_id, "caseId": case.get("publicId"), "attemptNo": attempt_no, **answer}

        stop: Json | None = link.get("stop")

        @step.do("reset", config=SAFE_TO_REPEAT)
        async def reset() -> Json:
            return await self._with_runner(ids, lambda runner, client, host: hosted.reset(runner, run_id))

        reset_answer = await reset()
        stop = stop or reset_answer.get("stop")
        _log_stop(run_id, stop)

        @step.do("finish", config=SAFE_TO_REPEAT)
        async def finish() -> Json:
            return await self._with_runner(ids, lambda runner, client, host: hosted.finish(client, run_id, stop))

        finished = await finish()
        _log_stop(run_id, finished.get("stop"))
        return {"runPublicId": run_id, **finished}

    async def _next(self, step, following: hosted.Link) -> None:
        """Creates the next link, once: a repeated step finds the instance it created (the id is fixed)."""
        instance_id = hosted.link_id(following)

        @step.do("next", config=SAFE_TO_REPEAT)
        async def next_link() -> Json:
            try:
                await self.env.EVAL_RUN_WORKFLOW.create(id=instance_id, params=dict(following))
            except Exception:
                # DEV_NOTE: Already created by an earlier try of this step when get finds it; else the create's error
                # stands and the step retries
                await self.env.EVAL_RUN_WORKFLOW.get(instance_id)
            return {"next": instance_id}

        await next_link()

    async def _fail_queued(self, step, params: Json) -> None:
        @step.do("fail queued run", config=SAFE_TO_REPEAT)
        async def fail_queued() -> Json:
            return _plain(await self.env.BACKEND.failQueuedRun(params))

        await fail_queued()

    async def _with_runner(
        self,
        ids: Json,
        use: Callable[[EvalRunner, EvalApiClient, Any], Awaitable[Json]],
    ) -> Json:
        """Runs one step with a runner signed in as the run's host test user. Never raises: a sign-in that can't be
        read stops the run like any other harness error."""
        try:
            async with self._runner(ids) as (runner, client, host):
                return await use(runner, client, host)
        except Exception as error:
            return {"stop": _stop_of(error)}

    @asynccontextmanager
    async def _runner(self, ids: Json) -> AsyncIterator[tuple[EvalRunner, EvalApiClient, Any]]:
        answer = _plain(await self.env.BACKEND.getRunLogin(ids))
        if not answer.get("isSuccess") or "runLogin" not in answer:
            raise ConfigError(f"The run's test sign-in couldn't be read: {answer.get('message')}")
        config = hosted.harness_config(
            answer["runLogin"],
            api_url=str(self.env.DILETTA_API_URL),
            private_jwk=load_private_jwk_from(str(self.env.EVAL_JWT_PRIVATE_KEY), is_curve_checked=False),
        )
        async with (
            httpx.AsyncClient(transport=BindingTransport(self.env.BACKEND)) as backend_http,
            httpx.AsyncClient() as host_http,
        ):
            client = EvalApiClient(config, backend_http, sign=WebCryptoSigner(config))
            host = host_login_for(config, host_http)
            yield EvalRunner(client, host, out=_LogOut()), client, host


class _LogOut:
    """The runner's progress lines go to Workers Logs (no case text: names and verdicts only, as the CLI prints)."""

    def write(self, text: str) -> int:
        line = text.rstrip("\n")
        if line:
            print(line)
        return len(text)

    def flush(self) -> None:
        return None


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # DEV_NOTE: No public routes: runs start only through the backend's Workflow binding
        return Response("Not found", status=404)
