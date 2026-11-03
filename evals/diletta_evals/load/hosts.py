"""The test host's login for many users at once (apps/test-host, M3-3): the admin mints each simulated user's companion JWT
(for the widget) and host token (for the chat's host calls) in one workspace of its own, so a run never sees another's
records. The async twin of hosts/testhost.py, which mints one test user's token for the eval harness."""

import secrets
from dataclasses import dataclass

import httpx

from diletta_evals.config import TestHostSettings
from diletta_evals.constants import TEST_HOST_ADMIN_HEADER as ADMIN_HEADER

MINT_TIMEOUT_SECONDS = 30.0


class MintError(Exception):
    """The test host wouldn't mint a token (status 0 = unreachable)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{message} (HTTP {status})" if status else message)
        self.status = status


@dataclass(frozen=True)
class UserTokens:
    companion_jwt: str
    host_token: str


def new_workspace() -> str:
    return f"ws_load_{secrets.token_hex(10)}"


async def mint_tokens(
    http: httpx.AsyncClient, settings: TestHostSettings, *, workspace: str, user: str
) -> UserTokens:
    try:
        response = await http.post(
            f"{settings.issuer}/auth/tokens",
            headers={ADMIN_HEADER: settings.admin_secret},
            json={"workspace": workspace, "sub": user},
            timeout=MINT_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        raise MintError(0, f"Test host unreachable: {type(error).__name__}") from error
    if response.status_code != 201:
        raise MintError(response.status_code, "Test host token mint failed")
    try:
        body = response.json()
        companion_jwt = body["companionJwt"]
        host_token = body["hostToken"]
    except (ValueError, KeyError, TypeError) as error:
        raise MintError(response.status_code, "Test host token mint answered something else") from error
    if not isinstance(companion_jwt, str) or not isinstance(host_token, str) or not companion_jwt or not host_token:
        raise MintError(response.status_code, "Test host token mint answered no token")
    return UserTokens(companion_jwt=companion_jwt, host_token=host_token)
