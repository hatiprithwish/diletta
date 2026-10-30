"""The harness's settings, from the environment (docs/runbooks/evals.md).

Nothing here is a default for a secret: a missing value is a ConfigError naming the variable.
"""

import json
import os
from dataclasses import dataclass
from enum import StrEnum

from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm
from jwt.exceptions import InvalidKeyError


class ConfigError(Exception):
    """A setting is missing or unreadable."""


class HostKind(StrEnum):
    """How the harness gets the host test user's bearer token (one login per host app)."""

    TEST_HOST = "test_host"


@dataclass(frozen=True)
class TestHostSettings:
    issuer: str
    admin_secret: str


@dataclass(frozen=True)
class HarnessConfig:
    # The backend worker the run drives (its /eval/* routes)
    api_url: str
    # The platform's eval signing key: a private ES256 JWK with its kid (the worker lists the public half in
    # EVAL_JWT_PUBLIC_JWKS)
    private_jwk: dict[str, object]
    # Public ids: the company and its staging connection the eval JWT names
    company_id: str
    connection_id: str
    # The host test user every eval conversation runs as (the token's sub, and the host login's user)
    host_user: str
    host_kind: HostKind
    test_host: TestHostSettings | None


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is not set")
    return value


def load_config() -> HarnessConfig:
    try:
        private_jwk = json.loads(_required("EVAL_JWT_PRIVATE_KEY"))
    except json.JSONDecodeError as error:
        raise ConfigError("EVAL_JWT_PRIVATE_KEY is not a JWK (JSON)") from error
    if not isinstance(private_jwk, dict) or not private_jwk.get("kid") or "d" not in private_jwk:
        raise ConfigError("EVAL_JWT_PRIVATE_KEY must be a private JWK with a kid")
    # DEV_NOTE: The worker verifies ES256 only: the key must be a P-256 private key, checked here, not at the first call
    try:
        key = ECAlgorithm.from_jwk(json.dumps(private_jwk))
    except (InvalidKeyError, ValueError, TypeError) as error:
        raise ConfigError("EVAL_JWT_PRIVATE_KEY is not an EC private JWK") from error
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ConfigError("EVAL_JWT_PRIVATE_KEY must be a P-256 (ES256) private key")

    raw_kind = os.environ.get("EVAL_HOST_KIND", HostKind.TEST_HOST.value).strip()
    try:
        host_kind = HostKind(raw_kind)
    except ValueError as error:
        kinds = ", ".join(kind.value for kind in HostKind)
        raise ConfigError(f"EVAL_HOST_KIND {raw_kind!r} has no host login (one of: {kinds})") from error

    test_host = None
    if host_kind is HostKind.TEST_HOST:
        test_host = TestHostSettings(
            issuer=_required("TEST_HOST_ISSUER").rstrip("/"),
            admin_secret=_required("TEST_HOST_ADMIN_SECRET"),
        )

    return HarnessConfig(
        api_url=_required("DILETTA_API_URL").rstrip("/"),
        private_jwk=private_jwk,
        company_id=_required("DILETTA_COMPANY_ID"),
        connection_id=_required("DILETTA_CONNECTION_ID"),
        host_user=_required("EVAL_HOST_USER"),
        host_kind=host_kind,
        test_host=test_host,
    )
