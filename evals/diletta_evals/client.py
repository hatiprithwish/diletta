"""The /eval/* API client (M5-2). Every request carries a freshly signed eval JWT; the calls that reach the host
(an attempt, a readback, the reset) also carry the host test user's bearer in X-Host-Token. Every answer is parsed
with the generated types (diletta_evals.types.eval_api), so a shape the backend changed fails here, loudly.
"""

from typing import Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from diletta_evals.config import HarnessConfig
from diletta_evals.eval_jwt import sign_eval_jwt
from diletta_evals.types import eval_api

# packages/schemas EVAL_HOST_TOKEN_HEADER
HOST_TOKEN_HEADER = "X-Host-Token"
# An attempt is one whole chatbot turn (tools, commit, verify): the worker's turn timeout plus room
REQUEST_TIMEOUT_SECONDS = 180.0

Answer = TypeVar("Answer", bound=BaseModel)


class EvalApiError(Exception):
    """A refusal from /eval/* (status, its failure enum as text) or an answer that didn't parse."""

    def __init__(self, status: int, message: str, failure: str | None = None) -> None:
        super().__init__(f"HTTP {status}: {message}" + (f" ({failure})" if failure else ""))
        self.status = status
        self.failure = failure


class EvalApi(Protocol):
    """What a run needs of the API (EvalApiClient; tests pass a fake)."""

    def start_run(self, request: eval_api.CreateEvalRunApiRequest) -> eval_api.CreateEvalRunApiResponse: ...

    def run_attempt(
        self, run_id: str, request: eval_api.RunEvalAttemptApiRequest, host_token: str
    ) -> eval_api.RunEvalAttemptApiResponse: ...

    def read_back(
        self, run_id: str, request: eval_api.EvalReadbackApiRequest, host_token: str
    ) -> eval_api.EvalReadbackApiResponse: ...

    def record_result(
        self, run_id: str, request: eval_api.RecordEvalResultApiRequest
    ) -> eval_api.RecordEvalResultApiResponse: ...

    def reset(self, run_id: str, host_token: str) -> eval_api.ResetEvalRunApiResponse: ...

    def finish(
        self, run_id: str, request: eval_api.FinishEvalRunApiRequest
    ) -> eval_api.FinishEvalRunApiResponse: ...


class EvalApiClient:
    def __init__(self, config: HarnessConfig, http: httpx.Client) -> None:
        self._config = config
        self._http = http

    def start_run(self, request: eval_api.CreateEvalRunApiRequest) -> eval_api.CreateEvalRunApiResponse:
        return self._post("/runs", request, eval_api.CreateEvalRunApiResponse)

    def run_attempt(
        self, run_id: str, request: eval_api.RunEvalAttemptApiRequest, host_token: str
    ) -> eval_api.RunEvalAttemptApiResponse:
        return self._post(f"/runs/{run_id}/attempts", request, eval_api.RunEvalAttemptApiResponse, host_token)

    def read_back(
        self, run_id: str, request: eval_api.EvalReadbackApiRequest, host_token: str
    ) -> eval_api.EvalReadbackApiResponse:
        return self._post(f"/runs/{run_id}/readbacks", request, eval_api.EvalReadbackApiResponse, host_token)

    def record_result(
        self, run_id: str, request: eval_api.RecordEvalResultApiRequest
    ) -> eval_api.RecordEvalResultApiResponse:
        return self._post(f"/runs/{run_id}/results", request, eval_api.RecordEvalResultApiResponse)

    def reset(self, run_id: str, host_token: str) -> eval_api.ResetEvalRunApiResponse:
        return self._post(f"/runs/{run_id}/reset", None, eval_api.ResetEvalRunApiResponse, host_token)

    def finish(
        self, run_id: str, request: eval_api.FinishEvalRunApiRequest
    ) -> eval_api.FinishEvalRunApiResponse:
        return self._post(f"/runs/{run_id}/finish", request, eval_api.FinishEvalRunApiResponse)

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
                content=body.model_dump_json() if body is not None else "{}",
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
