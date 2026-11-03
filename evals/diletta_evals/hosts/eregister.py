"""eRegister's login (M7-1): the staging test user signs in with Firebase email and password.

eRegister's API takes the user's Firebase ID token as its bearer token, so that is the host token the backend forwards
(jwt_forward). The token's uid must be EVAL_HOST_USER, the eval JWT's sub: the conversation runs as the user whose
token reaches the host. There is no reset (the connection has no reset_op yet), so prepare() does nothing and every
eRegister case names its own records with {case.tag}.
"""

import time

import httpx

from diletta_evals.client import REQUEST_TIMEOUT_SECONDS
from diletta_evals.config import ERegisterSettings
from diletta_evals.hosts.base import HostLoginError

FIREBASE_SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"

# DEV_NOTE: A token is replaced before a call unless it outlives the longest call: an attempt's whole turn
# (REQUEST_TIMEOUT_SECONDS) plus clock slack, so it never expires mid-attempt. Firebase ID tokens live an hour.
TOKEN_REFRESH_MARGIN_SECONDS = REQUEST_TIMEOUT_SECONDS + 30


class ERegisterLogin:
    def __init__(self, settings: ERegisterSettings, *, user: str, http: httpx.Client) -> None:
        self._settings = settings
        self._user = user
        self._http = http
        self._token: str | None = None
        self._expires_at = 0.0

    def prepare(self) -> None:
        # DEV_NOTE: Signs in once before the first attempt, so a bad password or uid stops the run before it starts
        self.host_token()

    def host_token(self) -> str:
        if self._token is None or self._expires_at - time.time() < TOKEN_REFRESH_MARGIN_SECONDS:
            self._token = self._sign_in()
        return self._token

    def _sign_in(self) -> str:
        try:
            response = self._http.post(
                FIREBASE_SIGN_IN_URL,
                params={"key": self._settings.firebase_api_key},
                json={
                    "email": self._settings.email,
                    "password": self._settings.password,
                    "returnSecureToken": True,
                },
            )
        except httpx.HTTPError as error:
            raise HostLoginError(f"Firebase sign-in unreachable: {type(error).__name__}") from error
        if response.status_code != 200:
            # DEV_NOTE: Firebase names the reason (INVALID_LOGIN_CREDENTIALS, USER_DISABLED…); never the email or password
            raise HostLoginError(
                f"eRegister test user sign-in failed: HTTP {response.status_code} {self._error_code(response)}"
            )
        try:
            body = response.json()
            token = body["idToken"]
            uid = body["localId"]
            expires_in = int(body["expiresIn"])
        except (ValueError, KeyError, TypeError) as error:
            raise HostLoginError("Firebase sign-in answered something else") from error
        if not isinstance(token, str) or not token:
            raise HostLoginError("Firebase sign-in answered no token")
        if uid != self._user:
            raise HostLoginError("The eRegister test user's uid is not EVAL_HOST_USER")
        self._expires_at = time.time() + expires_in
        return token

    @staticmethod
    def _error_code(response: httpx.Response) -> str:
        try:
            message = response.json()["error"]["message"]
        except (ValueError, KeyError, TypeError):
            return ""
        return message if isinstance(message, str) else ""
