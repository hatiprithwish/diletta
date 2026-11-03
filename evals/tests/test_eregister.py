"""eRegister's login (diletta_evals.hosts.eregister) against a mocked Firebase."""

import json

import httpx
import pytest

from diletta_evals.config import ERegisterSettings
from diletta_evals.hosts import eregister
from diletta_evals.hosts.base import HostLoginError

SETTINGS = ERegisterSettings(firebase_api_key="web-key", email="eval@example.com", password="secret")


def login_for(handle) -> tuple[eregister.ERegisterLogin, list[httpx.Request]]:
    sent: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return handle(request)

    http = httpx.Client(transport=httpx.MockTransport(record))
    return eregister.ERegisterLogin(SETTINGS, user="uid-eval", http=http), sent


def signed_in(expires_in: int, uid: str = "uid-eval"):
    def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"idToken": "id-token", "localId": uid, "expiresIn": str(expires_in), "refreshToken": "r"}
        )

    return handle


def test_signs_in_with_the_test_user_and_reuses_a_fresh_token() -> None:
    login, sent = login_for(signed_in(3600))
    login.prepare()
    assert login.host_token() == "id-token"
    [request] = sent
    assert request.url.host == "identitytoolkit.googleapis.com"
    assert request.url.params["key"] == "web-key"
    assert json.loads(request.content) == {
        "email": "eval@example.com",
        "password": "secret",
        "returnSecureToken": True,
    }


def test_signs_in_again_when_the_token_wouldnt_outlive_an_attempt() -> None:
    login, sent = login_for(signed_in(int(eregister.TOKEN_REFRESH_MARGIN_SECONDS) - 1))
    login.host_token()
    login.host_token()
    assert len(sent) == 2


def test_refuses_a_token_for_another_user() -> None:
    login, _ = login_for(signed_in(3600, uid="uid-someone-else"))
    with pytest.raises(HostLoginError, match="EVAL_HOST_USER"):
        login.prepare()


def test_a_refused_sign_in_names_firebases_reason_but_never_the_credentials() -> None:
    login, _ = login_for(
        lambda _request: httpx.Response(400, json={"error": {"message": "INVALID_LOGIN_CREDENTIALS"}})
    )
    with pytest.raises(HostLoginError, match="INVALID_LOGIN_CREDENTIALS") as raised:
        login.host_token()
    assert "secret" not in str(raised.value)
    assert "eval@example.com" not in str(raised.value)


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, content=b"not json"),
        httpx.Response(200, json={"localId": "uid-eval", "expiresIn": "3600"}),
        httpx.Response(200, json={"idToken": "", "localId": "uid-eval", "expiresIn": "3600"}),
        httpx.Response(200, json={"idToken": "t", "localId": "uid-eval", "expiresIn": "soon"}),
    ],
)
def test_an_unreadable_answer_is_a_login_error(answer: httpx.Response) -> None:
    login, _ = login_for(lambda _request: answer)
    with pytest.raises(HostLoginError):
        login.host_token()


def test_an_unreachable_firebase_is_a_login_error() -> None:
    def handle(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    login, _ = login_for(handle)
    with pytest.raises(HostLoginError, match="unreachable"):
        login.prepare()
