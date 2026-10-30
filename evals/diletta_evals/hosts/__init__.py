"""Host logins: how the harness gets the host test user's bearer token, one per host app (docs/runbooks/evals.md)."""

import httpx

from diletta_evals.config import ConfigError, HarnessConfig, HostKind
from diletta_evals.hosts.base import HostLogin, HostLoginError
from diletta_evals.hosts.testhost import TestHostLogin


def host_login_for(config: HarnessConfig, http: httpx.Client) -> HostLogin:
    if config.host_kind is HostKind.TEST_HOST and config.test_host is not None:
        return TestHostLogin(config.test_host, user=config.host_user, http=http)
    raise ConfigError(f"No host login for {config.host_kind.value}")


__all__ = ["HostLogin", "HostLoginError", "TestHostLogin", "host_login_for"]
