"""The CLI's exit codes (diletta_evals.__main__): 0 passed, 1 the run failed, 2 it couldn't run, whatever stopped it."""

import sys

import httpx
import pytest

from diletta_evals import __main__ as cli
from diletta_evals.client import EvalApiError
from diletta_evals.runner import ChatbotTarget, RunSummary


@pytest.fixture
def argv(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(sys, "argv", ["diletta_evals", "run", "--config", "cfg_1", "--k", "1"])
    monkeypatch.setattr(cli, "load_config", lambda: object())
    monkeypatch.setattr(cli, "EvalApiClient", lambda _config, _http: object())
    monkeypatch.setattr(cli, "host_login_for", lambda _config, _http: object())
    return monkeypatch


def runs(monkeypatch: pytest.MonkeyPatch, outcome: object) -> None:
    class Runner:
        def __init__(self, *_args: object) -> None:
            pass

        def run(self, **_kwargs: object) -> RunSummary:
            if isinstance(outcome, BaseException):
                raise outcome
            return RunSummary(run_id="run_1", has_passed=bool(outcome))

    monkeypatch.setattr(cli, "EvalRunner", Runner)


def test_passed_is_0_failed_is_1(argv: pytest.MonkeyPatch) -> None:
    runs(argv, True)
    assert cli.main() == cli.EXIT_PASSED
    runs(argv, False)
    assert cli.main() == cli.EXIT_FAILED


@pytest.mark.parametrize(
    "error",
    [
        EvalApiError(500, "Server error"),
        httpx.ConnectError("down"),
        ValueError("a bug in the harness"),
    ],
)
def test_anything_that_stops_the_run_is_2_never_a_regression(argv: pytest.MonkeyPatch, error: Exception) -> None:
    runs(argv, error)
    assert cli.main() == cli.EXIT_COULD_NOT_RUN


def test_k_is_bounded_by_the_contract(argv: pytest.MonkeyPatch) -> None:
    argv.setattr(sys, "argv", ["diletta_evals", "run", "--config", "cfg_1", "--k", str(cli.MAX_K + 1)])
    with pytest.raises(SystemExit):
        cli.main()


def test_runs_a_chatbot_by_its_published_config_but_never_a_gate(argv: pytest.MonkeyPatch) -> None:
    targets: list[object] = []

    class Runner:
        def __init__(self, *_args: object) -> None:
            pass

        def run(self, **kwargs: object) -> RunSummary:
            targets.append(kwargs["target"])
            return RunSummary(run_id="run_1", has_passed=True)

    argv.setattr(cli, "EvalRunner", Runner)
    argv.setattr(sys, "argv", ["diletta_evals", "run", "--chatbot", "bot_1", "--trigger", "nightly"])
    assert cli.main() == cli.EXIT_PASSED
    assert targets == [ChatbotTarget(chatbot_id="bot_1")]

    argv.setattr(sys, "argv", ["diletta_evals", "run", "--chatbot", "bot_1", "--trigger", "gate"])
    with pytest.raises(SystemExit):
        cli.main()
    argv.setattr(sys, "argv", ["diletta_evals", "run", "--chatbot", "bot_1", "--config", "cfg_1"])
    with pytest.raises(SystemExit):
        cli.main()
    argv.setattr(sys, "argv", ["diletta_evals", "run"])
    with pytest.raises(SystemExit):
        cli.main()
