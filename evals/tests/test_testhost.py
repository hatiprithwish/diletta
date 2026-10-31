"""The test host's login (diletta_evals.hosts.testhost) against a mocked transport."""

import time

import httpx
import pytest

from diletta_evals import config
from diletta_evals.constants import TEST_HOST_ADMIN_HEADER
from diletta_evals.hosts import testhost
from diletta_evals.hosts.base import HostLoginError

# DEV_NOTE: Module access, so pytest doesn't take the Test* classes for test classes
SETTINGS = config.TestHostSettings(issuer="https://test-host.example", admin_secret="admin-secret")


def login_for(handle) -> tuple[testhost.TestHostLogin, list[httpx.Request]]:
    sent: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return handle(request)

    http = httpx.Client(transport=httpx.MockTransport(record))
    return testhost.TestHostLogin(SETTINGS, user="eval-user", http=http), sent


def minted(expires_in: int):
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/tokens":
            return httpx.Response(201, json={"hostToken": "tok", "expiresAt": int(time.time()) + expires_in})
        return httpx.Response(200, json={"isSuccess": True})

    return handle


def test_mints_in_its_own_workspace_with_the_admin_secret_and_reuses_a_fresh_token() -> None:
    login, sent = login_for(minted(300))
    assert login.host_token() == "tok"
    assert login.host_token() == "tok"
    [mint] = sent
    assert mint.headers[TEST_HOST_ADMIN_HEADER] == "admin-secret"
    assert login.workspace in mint.content.decode()


def test_replaces_a_token_that_wouldnt_outlive_an_attempt() -> None:
    login, sent = login_for(minted(int(testhost.TOKEN_REFRESH_MARGIN_SECONDS) - 1))
    login.host_token()
    login.host_token()
    assert len(sent) == 2


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(403, json={"isSuccess": False}),
        httpx.Response(201, content=b"not json"),
        httpx.Response(201, json={"expiresAt": 1}),
        httpx.Response(201, json={"hostToken": "", "expiresAt": 1}),
    ],
)
def test_an_unreadable_or_refused_mint_is_a_login_error(answer: httpx.Response) -> None:
    login, _ = login_for(lambda _request: answer)
    with pytest.raises(HostLoginError):
        login.host_token()


def test_an_unreachable_host_is_a_login_error_on_prepare_too() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/_reset":
            raise httpx.ConnectError("down")
        return minted(300)(request)

    login, _ = login_for(handle)
    with pytest.raises(HostLoginError, match="unreachable"):
        login.prepare()
