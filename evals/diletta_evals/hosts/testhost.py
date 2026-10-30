"""The test host's login (apps/test-host, M3-3): the admin mints the host test user's token in a fresh workspace.

Each run gets its own workspace, so runs never see each other's records. A new workspace starts empty: prepare()
loads the seed records with POST /v1/_reset, the same call the connection's reset_op makes after the run.
"""

import secrets
import time

import httpx

from diletta_evals.client import REQUEST_TIMEOUT_SECONDS
from diletta_evals.config import TestHostSettings
from diletta_evals.constants import TEST_HOST_ADMIN_HEADER as ADMIN_HEADER
from diletta_evals.constants import TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS as TOKEN_LIFETIME_SECONDS
from diletta_evals.hosts.base import HostLoginError

# DEV_NOTE: A token is replaced before a call unless it outlives the longest call: an attempt's whole turn
# (REQUEST_TIMEOUT_SECONDS) plus clock slack, so it never expires mid-attempt
TOKEN_REFRESH_MARGIN_SECONDS = REQUEST_TIMEOUT_SECONDS + 30
if TOKEN_REFRESH_MARGIN_SECONDS >= TOKEN_LIFETIME_SECONDS:
    raise RuntimeError("A test host token must outlive one attempt")


class TestHostLogin:
    def __init__(self, settings: TestHostSettings, *, user: str, http: httpx.Client) -> None:
        self._settings = settings
        self._user = user
        self._http = http
        self.workspace = f"ws_{secrets.token_hex(12)}"
        self._token: str | None = None
        self._expires_at = 0

    def prepare(self) -> None:
        try:
            response = self._http.post(
                f"{self._settings.issuer}/v1/_reset",
                headers={"Authorization": f"Bearer {self.host_token()}"},
            )
        except httpx.HTTPError as error:
            raise HostLoginError(f"Test host unreachable: {type(error).__name__}") from error
        if response.status_code != 200:
            raise HostLoginError(f"Test host reset failed: HTTP {response.status_code}")

    def host_token(self) -> str:
        if self._token is None or self._expires_at - time.time() < TOKEN_REFRESH_MARGIN_SECONDS:
            self._token = self._mint()
        return self._token

    def _mint(self) -> str:
        try:
            response = self._http.post(
                f"{self._settings.issuer}/auth/tokens",
                headers={ADMIN_HEADER: self._settings.admin_secret},
                json={
                    "workspace": self.workspace,
                    "sub": self._user,
                    "expiresInSeconds": TOKEN_LIFETIME_SECONDS,
                },
            )
        except httpx.HTTPError as error:
            raise HostLoginError(f"Test host unreachable: {type(error).__name__}") from error
        if response.status_code != 201:
            raise HostLoginError(f"Test host token mint failed: HTTP {response.status_code}")
        try:
            body = response.json()
            expires_at = int(body["expiresAt"])
            token = body["hostToken"]
        except (ValueError, KeyError, TypeError) as error:
            raise HostLoginError("Test host token mint answered something else") from error
        if not isinstance(token, str) or not token:
            raise HostLoginError("Test host token mint answered no token")
        self._expires_at = expires_at
        return token
