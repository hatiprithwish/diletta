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


def test_a_raw_signature_over_the_shared_signing_input_verifies_like_pyjwts() -> None:
    # DEV_NOTE: The hosted runner's WebCrypto signs signing_input and answers raw r || s (M7-9); the worker must accept it
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    from diletta_evals.eval_jwt import compact_jws, eval_jwt_claims, signing_input

    private_jwk, public_jwks = generate_key_pair("raw-kid")
    key = ECAlgorithm.from_jwk(json.dumps(private_jwk))
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    claims = eval_jwt_claims(company_id="co_1", connection_id="cn_1", host_user="u")
    text = signing_input("raw-kid", claims)
    r, s = decode_dss_signature(key.sign(text.encode("ascii"), ec.ECDSA(hashes.SHA256())))
    token = compact_jws(text, r.to_bytes(32, "big") + s.to_bytes(32, "big"))

    decoded = jwt.decode(
        token, jwt.PyJWK(public_jwks["keys"][0]), algorithms=["ES256"], audience=claims["aud"]
    )
    assert decoded == claims
    assert jwt.get_unverified_header(token)["kid"] == "raw-kid"
