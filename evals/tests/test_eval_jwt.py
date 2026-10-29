"""The eval JWT the harness signs (diletta_evals.eval_jwt), checked the way the worker checks it."""

import json

import jwt
from jwt.algorithms import ECAlgorithm

from diletta_evals.eval_jwt import (
    EVAL_JWT_AUDIENCE,
    EVAL_JWT_ISSUER,
    generate_key_pair,
    sign_eval_jwt,
)


def test_signs_a_short_lived_es256_token_the_public_jwks_verifies() -> None:
    private_jwk, public_jwks = generate_key_pair("eval-test")
    assert "d" not in public_jwks["keys"][0]
    token = sign_eval_jwt(
        private_jwk, company_id="co_1", connection_id="cn_1", host_user="eval-user", now=1_800_000_000
    )
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "ES256" and header["kid"] == "eval-test"
    public_key = ECAlgorithm.from_jwk(json.dumps(public_jwks["keys"][0]))
    claims = jwt.decode(
        token,
        public_key,
        algorithms=["ES256"],
        audience=EVAL_JWT_AUDIENCE,
        issuer=EVAL_JWT_ISSUER,
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims["company"] == "co_1" and claims["connection"] == "cn_1" and claims["sub"] == "eval-user"
    assert 0 < claims["exp"] - claims["iat"] <= 300
    # DEV_NOTE: A JWS ES256 signature is r ‖ s, 64 bytes (what WebCrypto verifies in the worker)
    assert len(jwt.utils.base64url_decode(token.split(".")[2])) == 64
