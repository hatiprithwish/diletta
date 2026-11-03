"""The load test's settings and CLI (diletta_evals.load.config, the `load` command): a missing setting is a ConfigError
naming it, and the exit codes mean what the eval run's do: 0 met the target, 1 missed it, 2 couldn't run."""

import json
import sys

import pytest

from diletta_evals import __main__ as cli
from diletta_evals.config import ConfigError
from diletta_evals.eval_jwt import generate_key_pair
from diletta_evals.load import config as load_config
from diletta_evals.load import runner
from diletta_evals.load.verdict import Check

PRIVATE_JWK, _ = generate_key_pair("test-kid")
SETTINGS = {
    "DILETTA_API_URL": "https://worker.example/",
    "EVAL_JWT_PRIVATE_KEY": json.dumps(PRIVATE_JWK),
    "LOAD_COMPANY_ID": "co_load",
    "LOAD_CONNECTION_ID": "cn_load",
    "TEST_HOST_ISSUER": "https://test-host.example/",
    "TEST_HOST_ADMIN_SECRET": "admin-secret",
    "LOAD_ORIGIN": "https://app.example.com/",
}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name, value in SETTINGS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("LOAD_CHATBOT_ID", raising=False)
    return monkeypatch


def test_reads_the_load_companys_settings_and_trims_the_urls(env: pytest.MonkeyPatch) -> None:
    settings = load_config.load_load_settings()
    assert settings.api_url == "https://worker.example"
    assert (settings.company_id, settings.connection_id) == ("co_load", "cn_load")
    assert settings.test_host.issuer == "https://test-host.example"
    assert settings.origin == "https://app.example.com"
    assert settings.chatbot_id is None


def test_the_chatbot_is_optional(env: pytest.MonkeyPatch) -> None:
    env.setenv("LOAD_CHATBOT_ID", " bot_1 ")
    assert load_config.load_load_settings().chatbot_id == "bot_1"


@pytest.mark.parametrize("name", ["DILETTA_API_URL", "LOAD_COMPANY_ID", "LOAD_CONNECTION_ID", "LOAD_ORIGIN", "TEST_HOST_ADMIN_SECRET"])
def test_a_missing_setting_names_itself(env: pytest.MonkeyPatch, name: str) -> None:
    env.delenv(name)
    with pytest.raises(ConfigError, match=name):
        load_config.load_load_settings()


def test_the_eval_companys_settings_are_not_the_load_companys(env: pytest.MonkeyPatch) -> None:
    env.setenv("DILETTA_COMPANY_ID", "co_nightly")
    env.delenv("LOAD_COMPANY_ID")
    with pytest.raises(ConfigError, match="LOAD_COMPANY_ID"):
        load_config.load_load_settings()


def report(*, is_passed: bool) -> runner.LoadReport:
    loaded = runner.LoadReport(started_at="now", users=50, turns_per_user=4)
    loaded.chat_checks = [Check("a check", is_passed, "detail")]
    return loaded


def run_cli(monkeypatch: pytest.MonkeyPatch, *extra: str) -> int:
    monkeypatch.setattr(sys, "argv", ["diletta_evals", "load", *extra])
    return cli.main()


def test_exit_codes(env: pytest.MonkeyPatch) -> None:
    async def passes(*_args: object) -> runner.LoadReport:
        return report(is_passed=True)

    async def misses(*_args: object) -> runner.LoadReport:
        return report(is_passed=False)

    async def stops(*_args: object) -> runner.LoadReport:
        raise runner.LoadRunError("The backend refused the load test")

    async def breaks(*_args: object) -> runner.LoadReport:
        raise ValueError("a bug in the harness")

    for outcome, expected in [(passes, cli.EXIT_PASSED), (misses, cli.EXIT_FAILED), (stops, cli.EXIT_COULD_NOT_RUN), (breaks, cli.EXIT_COULD_NOT_RUN)]:
        env.setattr(runner, "run_load", outcome)
        assert run_cli(env) == expected


def test_missing_settings_are_2_not_a_miss(env: pytest.MonkeyPatch) -> None:
    env.delenv("LOAD_COMPANY_ID")
    assert run_cli(env) == cli.EXIT_COULD_NOT_RUN


def test_the_contention_holds_must_be_even_so_half_can_fit(env: pytest.MonkeyPatch) -> None:
    with pytest.raises(SystemExit):
        run_cli(env, "--contention-calls", "7")
    with pytest.raises(SystemExit):
        run_cli(env, "--users", "0")
