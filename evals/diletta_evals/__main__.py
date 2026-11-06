"""The harness CLI (docs/runbooks/evals.md).

    uv run --project evals python -m diletta_evals run --config <chatbotConfigPublicId> [--k 3] [--trigger gate]
    uv run --project evals python -m diletta_evals run --chatbot <chatbotPublicId> --trigger nightly
    uv run --project evals python -m diletta_evals keygen [--kid <kid>]
    uv run --project evals python -m diletta_evals load [--users 50] [--turns 4] [--report load-report.json]

run: exit 0 when the run passed, 1 when it ran and failed (the chatbot regressed), 2 when it couldn't run: settings,
the backend or the host, or any error that stopped the run before its verdict (never read as the chatbot failing).
load (M6-5, docs/runbooks/load.md): exit 0 when the platform met the load target, 1 when it ran and missed it, 2 when it
couldn't run (settings, the backend or the host).
keygen: a new platform eval key; the private JWK goes to the harness's EVAL_JWT_PRIVATE_KEY, the JWKS to the worker's
EVAL_JWT_PUBLIC_JWKS secret.
"""

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime

import httpx
from annotated_types import Le

from diletta_evals.client import EvalApiClient
from diletta_evals.config import ConfigError, load_config
from diletta_evals.eval_jwt import generate_key_pair
from diletta_evals.hosts import host_login_for
from diletta_evals.load.constants import TARGET_CONCURRENT_CHATS
from diletta_evals.runner import ChatbotTarget, ConfigTarget, EvalRunner, RunSummary
from diletta_evals.types import eval_api

EXIT_PASSED = 0
EXIT_FAILED = 1
EXIT_COULD_NOT_RUN = 2

# packages/schemas EVAL_RUN_MAX_K, read from the generated type
MAX_K = next(
    meta.le for meta in eval_api.CreateEvalRunByConfigApiRequest.model_fields["k"].metadata if isinstance(meta, Le)
)
TRIGGERS = {
    "manual": eval_api.Trigger.number_2,
    "gate": eval_api.Trigger.number_1,
    "nightly": eval_api.Trigger.number_3,
}


def _run(args: argparse.Namespace) -> int:
    try:
        config = load_config()
    except ConfigError as error:
        sys.stderr.write(f"{error}\n")
        return EXIT_COULD_NOT_RUN
    target = ChatbotTarget(chatbot_id=args.chatbot) if args.chatbot else ConfigTarget(config_id=args.config)

    async def run() -> RunSummary:
        async with httpx.AsyncClient() as http:
            runner = EvalRunner(EvalApiClient(config, http), host_login_for(config, http))
            return await runner.run(
                target=target, k=args.k, trigger=TRIGGERS[args.trigger], require_tool_cases=args.require_tool_cases
            )

    try:
        summary = asyncio.run(run())
    except Exception as error:
        # DEV_NOTE: Every error that stops a run is "couldn't run" (CI must never read it as a regression); the
        # expected ones (settings, backend, host) say why, anything else names its type
        sys.stderr.write(f"The run couldn't finish: {type(error).__name__}: {error}\n")
        return EXIT_COULD_NOT_RUN
    return EXIT_PASSED if summary.has_passed else EXIT_FAILED


def _load(args: argparse.Namespace) -> int:
    # DEV_NOTE: Imported here, so a plain eval run never loads the socket client
    from diletta_evals.load.config import load_load_settings
    from diletta_evals.load.runner import LoadArgs, LoadRunError, run_load

    try:
        settings = load_load_settings()
    except ConfigError as error:
        sys.stderr.write(f"{error}\n")
        return EXIT_COULD_NOT_RUN
    try:
        report = asyncio.run(
            run_load(
                settings,
                LoadArgs(
                    users=args.users,
                    turns=args.turns,
                    think_seconds=args.think_seconds,
                    ramp_seconds=args.ramp_seconds,
                    rate_down_percent=args.rate_down_percent,
                    contention_calls=args.contention_calls,
                    drain_seconds=args.drain_seconds,
                    report_path=args.report,
                ),
            )
        )
    except Exception as error:
        # DEV_NOTE: As for a run: anything that stops the load test before its verdict is "couldn't run", never a miss
        if not isinstance(error, LoadRunError):
            sys.stderr.write(f"The load test couldn't finish: {type(error).__name__}: {error}\n")
        else:
            sys.stderr.write(f"The load test couldn't finish: {error}\n")
        return EXIT_COULD_NOT_RUN
    sys.stdout.write("PASSED\n" if report.is_passed else "FAILED\n")
    return EXIT_PASSED if report.is_passed else EXIT_FAILED


def _keygen(args: argparse.Namespace) -> int:
    kid = args.kid or f"eval-{datetime.now(UTC):%Y%m%d}"
    private_jwk, public_jwks = generate_key_pair(kid)
    sys.stdout.write(
        "EVAL_JWT_PRIVATE_KEY (harness secret, never commit):\n"
        f"{json.dumps(private_jwk)}\n\n"
        "EVAL_JWT_PUBLIC_JWKS (worker secret, per env):\n"
        f"{json.dumps(public_jwks)}\n"
    )
    return 0


def _k(value: str) -> int:
    k = int(value)
    if not 1 <= k <= MAX_K:
        raise argparse.ArgumentTypeError(f"k is 1..{MAX_K}")
    return k


def _positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def _even_at_least_two(value: str) -> int:
    number = int(value)
    if number < 2 or number % 2:
        raise argparse.ArgumentTypeError("must be an even number, at least 2 (about half the holds must fit)")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(prog="diletta_evals")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run a config's eval cases on the staging connection")
    target = run.add_mutually_exclusive_group(required=True)
    target.add_argument("--config", help="the chatbot config's public id")
    target.add_argument(
        "--chatbot",
        help="a chatbot's public id: runs its published config at the start (the nightly suite); never a gate",
    )
    run.add_argument("--k", type=_k, default=3, help="attempts per case (pass^k), default 3")
    run.add_argument(
        "--trigger",
        choices=sorted(TRIGGERS),
        default="manual",
        help="gate: the publish gate of a config sent to testing (its finish makes it Ready or a draft again)",
    )
    run.add_argument(
        "--require-tool-cases",
        action="store_true",
        help="stop the run (exit 2) if no case expects a tool call: the nightly suite must test the action engine",
    )
    run.set_defaults(handler=_run)
    load = commands.add_parser("load", help="the load test: concurrent widget chats and BudgetDO contention (staging)")
    load.add_argument("--users", type=_positive, default=TARGET_CONCURRENT_CHATS, help=f"concurrent chats, default {TARGET_CONCURRENT_CHATS} (fewer is a smoke run that cannot meet the target)")
    load.add_argument("--turns", type=_positive, default=4, help="turns each user sends, default 4")
    load.add_argument("--think-seconds", type=float, default=7.0, help="seconds between a user's turns, default 7 (a user may send 10 a minute)")
    load.add_argument("--ramp-seconds", type=float, default=10.0, help="seconds over which the users connect, default 10")
    load.add_argument("--rate-down-percent", type=int, default=20, help="percent of users who rate their first reply down (each writes an outbox event), default 20")
    load.add_argument("--contention-calls", type=_even_at_least_two, default=200, help="holds sent at once in the contention phase, default 200")
    load.add_argument("--drain-seconds", type=float, default=180.0, help="how long to wait for spend and the outbox to settle, default 180")
    load.add_argument("--report", help="write the report as JSON to this path")
    load.set_defaults(handler=_load)
    keygen = commands.add_parser("keygen", help="a new platform eval signing key")
    keygen.add_argument("--kid", help="the key id (default eval-<date>)")
    keygen.set_defaults(handler=_keygen)
    args = parser.parse_args()
    # DEV_NOTE: A gate run tests the version an admin sent to testing, never whatever is published
    if args.command == "run" and args.chatbot and args.trigger == "gate":
        parser.error("--trigger gate needs --config")
    return int(args.handler(args))


if __name__ == "__main__":
    sys.exit(main())
