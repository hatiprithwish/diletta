"""The hosted eval runner (M7-9, ADR 0007): one Workflow instance per run the dashboard queued.

The backend starts EvalRunWorkflow with {companyPublicId, runPublicId} (the instance id is the run's public id). Each
step is diletta_evals.hosted, the CLI's own code, and returns plain JSON: Workflows persist step results and instance
params, so a step never returns the test sign-in, a host token or an eval JWT. A step that needs the host reads the
sign-in again over the BACKEND binding (EvalRunnerEntrypoint.getRunLogin) and signs in for itself, in isolate memory.

Attempt steps never retry (an attempt runs a chatbot turn and writes to the host: sent once, as the CLI does); a step
replayed after an eviction is recorded as interrupted by hosted.attempt. Whatever stops the attempts, the run is still
reset and finished, so it never stays Running; a run that couldn't start is failed through the binding (failQueuedRun).
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from workers import Response, WorkerEntrypoint, WorkflowEntrypoint

from diletta_evals import hosted
from diletta_evals.client import EvalApiClient
from diletta_evals.config import ConfigError, load_private_jwk_from
from diletta_evals.constants import RUN_FAILURE_HARNESS_ERROR
from diletta_evals.hosts import host_login_for
from diletta_evals.runner import EvalRunner
from webcrypto_jwt import WebCryptoSigner

# DEV_NOTE: Sent once: Workflows would otherwise retry a failed step, and a retried attempt is a second chatbot turn
SEND_ONCE = {"retries": {"limit": 0, "delay": "1 second"}}
# DEV_NOTE: A reset, a finish and the binding calls are safe to repeat (the client also retries a reset itself)
SAFE_TO_REPEAT = {"retries": {"limit": 2, "delay": "10 seconds", "backoff": "linear"}}

Json = dict[str, Any]


def _plain(value: Any) -> Any:
    """A JS answer over RPC as plain Python JSON (nested JsProxy dicts included)."""
    if hasattr(value, "to_py"):
        value = value.to_py()
    return json.loads(json.dumps(value))


def _stop_of(error: BaseException) -> Json:
    return {"failure": RUN_FAILURE_HARNESS_ERROR.value, "message": f"{type(error).__name__}: {error}"[:500]}


class EvalRunWorkflow(WorkflowEntrypoint):
    async def run(self, event, step):
        params = _plain(event["payload"])
        run_id = str(params["runPublicId"])

        @step.do("start", config=SEND_ONCE)
        async def start() -> Json:
            return await self._with_runner(params, lambda runner, client, host: hosted.start(runner, host, run_id))

        started = await start()
        if "stop" in started:
            await self._fail_queued(step, params)
            return {"runPublicId": run_id, "stop": started["stop"]}

        # DEV_NOTE: One step per attempt, built by a factory: a step function takes no parameters (the SDK injects
        # parameters by name), so its case and attempt are captured here
        def attempt_step(case: Json, attempt_no: int, name: str) -> Callable[[], Awaitable[Json]]:
            @step.do(name, config=SEND_ONCE)
            async def attempt() -> Json:
                return await self._with_runner(
                    params,
                    lambda runner, client, host: hosted.attempt(runner, client, run_id, case, attempt_no),
                )

            return attempt

        stop: Json | None = None
        for case_index, case in enumerate(started["cases"]):
            for attempt_no in range(1, int(started["k"]) + 1):
                answer = await attempt_step(case, attempt_no, f"case {case_index + 1} attempt {attempt_no}")()
                if "stop" in answer:
                    stop = answer["stop"]
                    break
            if stop is not None:
                break

        @step.do("reset", config=SAFE_TO_REPEAT)
        async def reset() -> Json:
            return await self._with_runner(params, lambda runner, client, host: hosted.reset(runner, run_id))

        reset_answer = await reset()
        stop = stop or reset_answer.get("stop")

        @step.do("finish", config=SAFE_TO_REPEAT)
        async def finish() -> Json:
            return await self._with_runner(params, lambda runner, client, host: hosted.finish(client, run_id, stop))

        return {"runPublicId": run_id, **(await finish())}

    async def _fail_queued(self, step, params: Json) -> None:
        @step.do("fail queued run", config=SAFE_TO_REPEAT)
        async def fail_queued() -> Json:
            return _plain(await self.env.BACKEND.failQueuedRun(params))

        await fail_queued()

    async def _with_runner(
        self,
        params: Json,
        use: Callable[[EvalRunner, EvalApiClient, Any], Awaitable[Json]],
    ) -> Json:
        """Runs one step with a runner signed in as the run's host test user. Never raises: a sign-in that can't be
        read stops the run like any other harness error."""
        try:
            async with self._runner(params) as (runner, client, host):
                return await use(runner, client, host)
        except Exception as error:
            return {"stop": _stop_of(error)}

    @asynccontextmanager
    async def _runner(self, params: Json) -> AsyncIterator[tuple[EvalRunner, EvalApiClient, Any]]:
        answer = _plain(await self.env.BACKEND.getRunLogin(params))
        if not answer.get("isSuccess") or "runLogin" not in answer:
            raise ConfigError(f"The run's test sign-in couldn't be read: {answer.get('message')}")
        config = hosted.harness_config(
            answer["runLogin"],
            api_url=str(self.env.DILETTA_API_URL),
            private_jwk=load_private_jwk_from(str(self.env.EVAL_JWT_PRIVATE_KEY), is_curve_checked=False),
        )
        async with httpx.AsyncClient() as http:
            client = EvalApiClient(config, http, sign=WebCryptoSigner(config))
            host = host_login_for(config, http)
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
