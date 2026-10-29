"""The test host's login (apps/test-host, M3-3): the admin mints the host test user's token in a fresh workspace.

Each run gets its own workspace, so runs never see each other's records. A new workspace starts empty: prepare()
loads the seed records with POST /v1/_reset, the same call the connection's reset_op makes after the run.
"""

import secrets
import time

import httpx

from diletta_evals.config import TestHostSettings

# packages/schemas TEST_HOST_ADMIN_HEADER / TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS
ADMIN_HEADER = "X-Test-Host-Admin"
TOKEN_LIFETIME_SECONDS = 300
# A token with less left than this is replaced before a call (an attempt's turn can take a minute)
TOKEN_REFRESH_MARGIN_SECONDS = 120


class HostLoginError(Exception):
    """The host refused or didn't answer the login."""


class TestHostLogin:
    def __init__(self, settings: TestHostSettings, *, user: str, http: httpx.Client) -> None:
        self._settings = settings
        self._user = user
        self._http = http
        self.workspace = f"ws_{secrets.token_hex(12)}"
        self._token: str | None = None
        self._expires_at = 0

    def prepare(self) -> None:
        response = self._http.post(
            f"{self._settings.issuer}/v1/_reset",
            headers={"Authorization": f"Bearer {self.host_token()}"},
        )
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
        body = response.json()
        self._expires_at = int(body["expiresAt"])
        return str(body["hostToken"])
