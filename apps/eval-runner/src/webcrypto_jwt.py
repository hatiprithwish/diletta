"""The eval JWT signed with the Worker's WebCrypto (M7-9): the same claims and signing input as the CLI's pyjwt
signer (diletta_evals.eval_jwt), so the runner bundles neither `cryptography` nor pyjwt's crypto backend. WebCrypto's
ECDSA signature is raw r || s, which is exactly ES256's JWS signature."""

import json

from js import JSON, Object, Uint8Array, crypto
from pyodide.ffi import to_js

from diletta_evals.config import HarnessConfig
from diletta_evals.eval_jwt import compact_jws, eval_jwt_claims, signing_input


class WebCryptoSigner:
    """A TokenSigner for EvalApiClient: imports the private JWK once (non-extractable), signs a fresh JWT per call."""

    def __init__(self, config: HarnessConfig) -> None:
        self._config = config
        self._key = None

    async def __call__(self) -> str:
        if self._key is None:
            jwk = JSON.parse(json.dumps(self._config.private_jwk))
            algorithm = to_js({"name": "ECDSA", "namedCurve": "P-256"}, dict_converter=Object.fromEntries)
            self._key = await crypto.subtle.importKey("jwk", jwk, algorithm, False, to_js(["sign"]))
        claims = eval_jwt_claims(
            company_id=self._config.company_id,
            connection_id=self._config.connection_id,
            host_user=self._config.host_user,
        )
        text = signing_input(str(self._config.private_jwk["kid"]), claims)
        data = Uint8Array.new(to_js(list(text.encode("ascii"))))
        params = to_js({"name": "ECDSA", "hash": "SHA-256"}, dict_converter=Object.fromEntries)
        signature = await crypto.subtle.sign(params, self._key, data)
        return compact_jws(text, bytes(Uint8Array.new(signature).to_py()))
