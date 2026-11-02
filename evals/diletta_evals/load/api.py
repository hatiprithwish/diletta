"""The /eval/load/* API client (M6-5). Every request carries a freshly signed eval JWT for the load test company's staging
connection. Every answer is parsed with the generated types (diletta_evals.types.eval_load), so a shape the backend
changed fails here, loudly.

Retries: a window and a summary are reads (the window only starts timings over), so they are sent again on a dropped
connection or a 5xx. A reserve and a release are measurements: they are sent once, and a failure is the result.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TypeVar
from uuid import UUID

import httpx
from pydantic import BaseModel, ValidationError

from diletta_evals.eval_jwt import sign_eval_jwt
from diletta_evals.load.config import LoadSettings
from diletta_evals.types import eval_load

# The sub of the eval token: the load test has no host user of its own on this API
LOAD_HARNESS_SUBJECT = "load-harness"
REQUEST_TIMEOUT_SECONDS = 60.0
RETRIES = 2
RETRY_BACKOFF_SECONDS = 2.0

Answer = TypeVar("Answer", bound=BaseModel)


class LoadApiError(Exception):
    """A refusal from /eval/load/* (status 0 = unreachable; failure = the refusal's failure enum) or an unreadable answer."""

    def __init__(self, status: int, message: str, failure: eval_load.Failure | None = None) -> None:
        super().__init__(f"HTTP {status}: {message}" + (f" ({failure.value})" if failure else ""))
        self.status = status
        self.failure = failure

    @property
    def is_server_error(self) -> bool:
        """The backend failed (a 5xx) or couldn't be reached: what the load test must not see."""
        return self.status == 0 or self.status >= 500


def iso_utc(moment: datetime) -> str:
    """A moment as the API reads it: UTC, milliseconds, a Z (a lower bound of the exact one, which has microseconds)."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LoadApiClient:
    def __init__(self, settings: LoadSettings, http: httpx.AsyncClient) -> None:
        self._settings = settings
        self._http = http

    async def start_window(self) -> eval_load.EvalLoadWindowApiResponse:
        return await self._retried(lambda: self._send("POST", "/window", None, eval_load.EvalLoadWindowApiResponse))

    async def summary(self, since: datetime) -> eval_load.EvalLoadSummaryApiResponse:
        query = {"since": iso_utc(since)}
        return await self._retried(
            lambda: self._send("GET", "/summary", None, eval_load.EvalLoadSummaryApiResponse, query)
        )

    async def reserve(self, amount_micros: int) -> eval_load.EvalLoadReserveApiResponse:
        request = eval_load.EvalLoadReserveApiRequest(amountMicros=amount_micros)
        return await self._send("POST", "/reserve", request, eval_load.EvalLoadReserveApiResponse)

    async def release(self, reservation_id: UUID) -> eval_load.EvalLoadReleaseApiResponse:
        request = eval_load.EvalLoadReleaseApiRequest(reservationId=reservation_id)
        return await self._send("POST", "/release", request, eval_load.EvalLoadReleaseApiResponse)

    async def _retried(self, send: Callable[[], Awaitable[Answer]]) -> Answer:
        attempt = 0
        while True:
            try:
                return await send()
            except LoadApiError as error:
                if not error.is_server_error or attempt == RETRIES:
                    raise
                attempt += 1
                await asyncio.sleep(RETRY_BACKOFF_SECONDS * attempt)

    async def _send(
        self,
        method: str,
        path: str,
        body: BaseModel | None,
        answer: type[Answer],
        query: dict[str, str] | None = None,
    ) -> Answer:
        token = sign_eval_jwt(
            self._settings.private_jwk,
            company_id=self._settings.company_id,
            connection_id=self._settings.connection_id,
            host_user=LOAD_HARNESS_SUBJECT,
        )
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            response = await self._http.request(
                method,
                f"{self._settings.api_url}/eval/load{path}",
                headers=headers,
                params=query,
                content=body.model_dump_json() if body is not None else ("{}" if method == "POST" else None),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            raise LoadApiError(0, f"The backend is unreachable: {type(error).__name__}") from error
        if response.status_code >= 400:
            try:
                refusal = eval_load.EvalRefusalApiResponse.model_validate_json(response.content)
            except ValidationError:
                raise LoadApiError(response.status_code, "Refused") from None
            raise LoadApiError(response.status_code, refusal.message, refusal.failure)
        try:
            return answer.model_validate_json(response.content)
        except ValidationError as error:
            raise LoadApiError(response.status_code, f"The answer doesn't match {answer.__name__}") from error
