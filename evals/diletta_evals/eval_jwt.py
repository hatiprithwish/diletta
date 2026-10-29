"""The platform-signed eval JWT (M5-2): ES256, short-lived, signed fresh for every /eval/* request.

The claims mirror packages/schemas ZEvalJwtClaims: iss/aud are the platform constants, company and connection are the
public ids of the company and its staging connection, sub is the host test user.
"""

import json
import time

import jwt
from jwt.algorithms import ECAlgorithm

# packages/schemas EVAL_JWT_ISSUER / EVAL_JWT_AUDIENCE: the worker refuses anything else
EVAL_JWT_ISSUER = "diletta-eval-harness"
EVAL_JWT_AUDIENCE = "diletta-eval"
# Well under EVAL_JWT_MAX_LIFETIME_SECONDS (300): a token outlives one request only
EVAL_JWT_LIFETIME_SECONDS = 120


def sign_eval_jwt(
    private_jwk: dict[str, object],
    *,
    company_id: str,
    connection_id: str,
    host_user: str,
    now: int | None = None,
) -> str:
    issued_at = int(time.time()) if now is None else now
    key = ECAlgorithm.from_jwk(json.dumps(private_jwk))
    claims = {
        "iss": EVAL_JWT_ISSUER,
        "aud": EVAL_JWT_AUDIENCE,
        "sub": host_user,
        "iat": issued_at,
        "exp": issued_at + EVAL_JWT_LIFETIME_SECONDS,
        "company": company_id,
        "connection": connection_id,
    }
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": str(private_jwk["kid"])})


def generate_key_pair(kid: str) -> tuple[dict[str, object], dict[str, list[dict[str, object]]]]:
    """A new P-256 key: (private JWK for EVAL_JWT_PRIVATE_KEY, public JWKS for the worker's EVAL_JWT_PUBLIC_JWKS)."""
    from cryptography.hazmat.primitives.asymmetric import ec

    private_key = ec.generate_private_key(ec.SECP256R1())
    private_jwk: dict[str, object] = {
        **ECAlgorithm.to_jwk(private_key, as_dict=True),
        "kid": kid,
        "alg": "ES256",
        "use": "sig",
    }
    public_jwk = {name: value for name, value in private_jwk.items() if name != "d"}
    return private_jwk, {"keys": [public_jwk]}
