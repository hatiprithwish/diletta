"""What a host login gives the harness."""

from typing import Protocol


class HostLoginError(Exception):
    """The host refused, didn't answer, or answered the login with something unreadable."""


class HostLogin(Protocol):
    def prepare(self) -> None:
        """Gets the host ready for a run before its first attempt (nothing for a host that needs nothing)."""

    def host_token(self) -> str:
        """The host test user's bearer token, fresh enough for one /eval/* call (an attempt's whole turn)."""
