"""The load test's settings, from the environment (docs/runbooks/load.md).

The key, the API and the test host are the eval harness's own (EVAL_JWT_PRIVATE_KEY, DILETTA_API_URL, TEST_HOST_*); the
company and its staging connection are the load test company's (LOAD_*), so a shell that holds both never mixes them
up. Nothing here is a default for a secret: a missing value is a ConfigError naming the variable.
"""

import os
from dataclasses import dataclass

from diletta_evals.config import ConfigError, TestHostSettings, load_private_jwk, required_setting


@dataclass(frozen=True)
class LoadSettings:
    api_url: str
    private_jwk: dict[str, object]
    # Public ids: the load test company and its staging connection the eval JWT names
    company_id: str
    connection_id: str
    test_host: TestHostSettings
    # An origin the load test company's connection allows: the widget's Origin on /widget/*
    origin: str
    # The chatbot the chats talk to (public id); None = the company's default
    chatbot_id: str | None


def load_load_settings() -> LoadSettings:
    private_jwk = load_private_jwk()
    return LoadSettings(
        api_url=required_setting("DILETTA_API_URL").rstrip("/"),
        private_jwk=private_jwk,
        company_id=required_setting("LOAD_COMPANY_ID"),
        connection_id=required_setting("LOAD_CONNECTION_ID"),
        test_host=TestHostSettings(
            issuer=required_setting("TEST_HOST_ISSUER").rstrip("/"),
            admin_secret=required_setting("TEST_HOST_ADMIN_SECRET"),
        ),
        origin=required_setting("LOAD_ORIGIN").rstrip("/"),
        chatbot_id=os.environ.get("LOAD_CHATBOT_ID", "").strip() or None,
    )


__all__ = ["ConfigError", "LoadSettings", "load_load_settings"]
