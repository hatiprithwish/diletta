"""The /eval/* API client (M5-2). Every request carries a freshly signed eval JWT; the calls that reach the host
(an attempt, a readback, the reset) also carry the host test user's bearer in X-Host-Token. Every answer is parsed
with the generated types (diletta_evals.types.eval_api), so a shape the backend changed fails here, loudly.

Retries: a readback, a judge, a result and the reset are safe to send again (a read; a read and a model call; append-
only, where a repeat after a lost answer is Duplicate, meaning the first one landed; one idempotency key per run), so
they are retried on a dropped connection or a 5xx. A judge refused as JudgeUnavailable isn't: the backend already gave
the model its own retries, and the run stops on it. Starting a run, an attempt (it runs a turn and writes to the host:
a repeat is refused) and the finish are sent once.
"""

import time
from collections.abc import Callable
from typing import Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from diletta_evals.config import HarnessConfig
from diletta_evals.constants import EVAL_HOST_TOKEN_HEADER as HOST_TOKEN_HEADER
from diletta_evals.eval_jwt import sign_eval_jwt
from diletta_evals.types import eval_api

# An attempt is one whole chatbot turn (tools, commit, verify): the worker's turn timeout plus room
REQUEST_TIMEOUT_SECONDS = 180.0
# A safe call is sent at most 1 + RETRIES times, RETRY_BACKOFF_SECONDS × the try number apart
RETRIES = 2
RETRY_BACKOFF_SECONDS = 2.0

Answer = TypeVar("Answer", bound=BaseModel)


class EvalApiError(Exception):
    """A refusal from /eval/* (status 0 = unreachable; failure = the refusal's failure enum) or an unreadable answer."""

    def __init__(self, status: int, message: str, failure: eval_api.Failure | None = None) -> None:
        super().__init__(f"HTTP {status}: {message}" + (f" ({failure.value})" if failure else ""))
        self.status = status
        self.failure = failure

    @property
    def is_transient(self) -> bool:
        """Unreachable or a 5xx: the same request may go through when sent again."""
        return self.status == 0 or self.status >= 500


class EvalApi(Protocol):
    """What a run needs of the API (EvalApiClient; tests pass a fake)."""

    def start_run(self, request: eval_api.CreateEvalRunApiRequest) -> eval_api.CreateEvalRunApiResponse: ...

    def run_attempt(
        self, run_id: str, request: eval_api.RunEvalAttemptApiRequest, host_token: str
    ) -> eval_api.RunEvalAttemptApiResponse: ...

    def read_back(
        self, run_id: str, request: eval_api.EvalReadbackApiRequest, host_token: str
    ) -> eval_api.EvalReadbackApiResponse: ...

    def judge(self, run_id: str, request: eval_api.EvalJudgeApiRequest) -> eval_api.EvalJudgeApiResponse: ...

    def record_result(
        self, run_id: str, request: eval_api.RecordEvalResultApiRequest
    ) -> eval_api.RecordEvalResultApiResponse: ...

    def reset(self, run_id: str, host_token: str) -> eval_api.ResetEvalRunApiResponse: ...

    def finish(
        self, run_id: str, request: eval_api.FinishEvalRunApiRequest
    ) -> eval_api.FinishEvalRunApiResponse: ...


class EvalApiClient:
    def __init__(
        self, config: HarnessConfig, http: httpx.Client, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        self._config = config
        self._http = http
        self._sleep = sleep

    def start_run(self, request: eval_api.CreateEvalRunApiRequest) -> eval_api.CreateEvalRunApiResponse:
        return self._post("/runs", request, eval_api.CreateEvalRunApiResponse)

    def run_attempt(
        self, run_id: str, request: eval_api.RunEvalAttemptApiRequest, host_token: str
    ) -> eval_api.RunEvalAttemptApiResponse:
        return self._post(f"/runs/{run_id}/attempts", request, eval_api.RunEvalAttemptApiResponse, host_token)

    def read_back(
        self, run_id: str, request: eval_api.EvalReadbackApiRequest, host_token: str
    ) -> eval_api.EvalReadbackApiResponse:
        return self._retried(
            lambda: self._post(
                f"/runs/{run_id}/readbacks", request, eval_api.EvalReadbackApiResponse, host_token
            )
        )

    def judge(self, run_id: str, request: eval_api.EvalJudgeApiRequest) -> eval_api.EvalJudgeApiResponse:
        return self._retried(
            lambda: self._post(f"/runs/{run_id}/judge", request, eval_api.EvalJudgeApiResponse),
            final_failures=frozenset({eval_api.Failure.JudgeUnavailable}),
        )

    def record_result(
        self, run_id: str, request: eval_api.RecordEvalResultApiRequest
    ) -> eval_api.RecordEvalResultApiResponse:
        recorded = eval_api.RecordEvalResultApiResponse(isSuccess=True, message="Eval result recorded")
        return self._retried(
            lambda: self._post(f"/runs/{run_id}/results", request, eval_api.RecordEvalResultApiResponse),
            # DEV_NOTE: A retry refused as Duplicate: the try whose answer was lost recorded it
            on_retry_duplicate=recorded,
        )

    def reset(self, run_id: str, host_token: str) -> eval_api.ResetEvalRunApiResponse:
        return self._retried(
            lambda: self._post(f"/runs/{run_id}/reset", None, eval_api.ResetEvalRunApiResponse, host_token)
        )

    def finish(
        self, run_id: str, request: eval_api.FinishEvalRunApiRequest
    ) -> eval_api.FinishEvalRunApiResponse:
        return self._post(f"/runs/{run_id}/finish", request, eval_api.FinishEvalRunApiResponse)

    def _retried(
        self,
        send: Callable[[], Answer],
        on_retry_duplicate: Answer | None = None,
        final_failures: frozenset[eval_api.Failure] = frozenset(),
    ) -> Answer:
        attempt = 0
        while True:
            try:
                return send()
            except EvalApiError as error:
                if attempt > 0 and on_retry_duplicate is not None and error.failure is eval_api.Failure.Duplicate:
                    return on_retry_duplicate
                if not error.is_transient or error.failure in final_failures or attempt == RETRIES:
                    raise
                attempt += 1
                self._sleep(RETRY_BACKOFF_SECONDS * attempt)

    def _post(
        self,
        path: str,
        body: BaseModel | None,
        answer: type[Answer],
        host_token: str | None = None,
    ) -> Answer:
        token = sign_eval_jwt(
            self._config.private_jwk,
            company_id=self._config.company_id,
            connection_id=self._config.connection_id,
            host_user=self._config.host_user,
        )
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        if host_token is not None:
            headers[HOST_TOKEN_HEADER] = host_token
        try:
            response = self._http.post(
                f"{self._config.api_url}/eval{path}",
                headers=headers,
                # DEV_NOTE: An optional field left unset stays out of the body (the backend's optional fields refuse null);
                # a field set to None, a nullable one, is sent as null
                content=body.model_dump_json(exclude_unset=True) if body is not None else "{}",
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise EvalApiError(0, f"The backend is unreachable: {type(error).__name__}") from error
        if response.status_code >= 400:
            try:
                refusal = eval_api.EvalRefusalApiResponse.model_validate_json(response.content)
            except ValidationError:
                raise EvalApiError(response.status_code, "Refused") from None
            raise EvalApiError(response.status_code, refusal.message, refusal.failure)
        try:
            return answer.model_validate_json(response.content)
        except ValidationError as error:
            raise EvalApiError(response.status_code, f"The answer doesn't match {answer.__name__}") from error
