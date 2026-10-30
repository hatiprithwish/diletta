"""The harness's settings (diletta_evals.config): a missing or unusable setting is a ConfigError naming it."""

import json

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from diletta_evals.config import ConfigError, load_config
from diletta_evals.eval_jwt import generate_key_pair

PRIVATE_JWK, _ = generate_key_pair("test-kid")
SETTINGS = {
    "DILETTA_API_URL": "https://worker.example/",
    "EVAL_JWT_PRIVATE_KEY": json.dumps(PRIVATE_JWK),
    "DILETTA_COMPANY_ID": "co_1",
    "DILETTA_CONNECTION_ID": "cn_1",
    "EVAL_HOST_USER": "eval-user",
    "TEST_HOST_ISSUER": "https://test-host.example/",
    "TEST_HOST_ADMIN_SECRET": "admin-secret",
}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch):
    for name, value in SETTINGS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("EVAL_HOST_KIND", raising=False)
    return monkeypatch


def test_reads_every_setting_and_trims_trailing_slashes(env: pytest.MonkeyPatch) -> None:
    config = load_config()
    assert config.api_url == "https://worker.example"
    assert config.test_host is not None and config.test_host.issuer == "https://test-host.example"
    assert config.private_jwk["kid"] == "test-kid"


@pytest.mark.parametrize("name", ["DILETTA_API_URL", "DILETTA_CONNECTION_ID", "TEST_HOST_ADMIN_SECRET"])
def test_a_missing_setting_names_itself(env: pytest.MonkeyPatch, name: str) -> None:
    env.delenv(name)
    with pytest.raises(ConfigError, match=name):
        load_config()


def p384_jwk() -> str:
    key = ECAlgorithm.to_jwk(ec.generate_private_key(ec.SECP384R1()), as_dict=True)
    return json.dumps({**key, "kid": "p384"})


@pytest.mark.parametrize(
    ("value", "says"),
    [
        ("not json", "not a JWK"),
        (json.dumps({"kty": "EC", "kid": "k"}), "private JWK"),
        (json.dumps({**PRIVATE_JWK, "x": "AAAA"}), "EC private JWK"),
        (p384_jwk(), "P-256"),
    ],
)
def test_refuses_a_key_the_worker_wont_verify(env: pytest.MonkeyPatch, value: str, says: str) -> None:
    env.setenv("EVAL_JWT_PRIVATE_KEY", value)
    with pytest.raises(ConfigError, match=says):
        load_config()


def test_an_unknown_host_kind_lists_the_known_ones(env: pytest.MonkeyPatch) -> None:
    env.setenv("EVAL_HOST_KIND", "eregister")
    with pytest.raises(ConfigError, match="test_host"):
        load_config()
