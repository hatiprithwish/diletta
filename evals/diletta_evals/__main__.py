"""The harness CLI (docs/runbooks/evals.md).

    uv run --project evals python -m diletta_evals run --config <chatbotConfigPublicId> [--k 3]
    uv run --project evals python -m diletta_evals keygen [--kid <kid>]

run: exit 0 when the run passed, 1 when it failed, 2 when it couldn't run (settings, backend, host).
keygen: a new platform eval key; the private JWK goes to the harness's EVAL_JWT_PRIVATE_KEY, the JWKS to the worker's
EVAL_JWT_PUBLIC_JWKS secret.
"""

import argparse
import json
import sys
from datetime import UTC, datetime

import httpx

from diletta_evals.client import EvalApiClient, EvalApiError
from diletta_evals.config import ConfigError, load_config
from diletta_evals.eval_jwt import generate_key_pair
from diletta_evals.hosts import host_login_for
from diletta_evals.hosts.testhost import HostLoginError
from diletta_evals.runner import EvalRunner
from diletta_evals.types import eval_api

# packages/schemas EVAL_RUN_MAX_K
MAX_K = 10
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
        return 2
    with httpx.Client() as http:
        try:
            runner = EvalRunner(EvalApiClient(config, http), host_login_for(config, http))
            summary = runner.run(config_id=args.config, k=args.k, trigger=TRIGGERS[args.trigger])
        except (ConfigError, EvalApiError, HostLoginError) as error:
            sys.stderr.write(f"The run couldn't finish: {error}\n")
            return 2
    return 0 if summary.has_passed else 1


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


def main() -> int:
    parser = argparse.ArgumentParser(prog="diletta_evals")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run a config's eval cases on the staging connection")
    run.add_argument("--config", required=True, help="the chatbot config's public id")
    run.add_argument("--k", type=_k, default=3, help="attempts per case (pass^k), default 3")
    run.add_argument("--trigger", choices=sorted(TRIGGERS), default="manual")
    run.set_defaults(handler=_run)
    keygen = commands.add_parser("keygen", help="a new platform eval signing key")
    keygen.add_argument("--kid", help="the key id (default eval-<date>)")
    keygen.set_defaults(handler=_keygen)
    args = parser.parse_args()
    return int(args.handler(args))


if __name__ == "__main__":
    sys.exit(main())
