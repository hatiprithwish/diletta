// DEV_NOTE: The test host's bindings for a test run (its own tests, and the backend's, where it runs as an auxiliary
// worker): a fresh ES256 key and admin secret per run, never the .dev.vars or staging ones, under a fixed fake issuer.
// Plain WebCrypto with no @app/schemas import, since vitest configs load it before any alias applies; the shape is
// Schemas.ZTestHostSigningKey, which the test host parses on every use.
export const TEST_HOST_TEST_ISSUER = "https://test-host.diletta.test";

export interface TestHostTestBindings {
  TEST_HOST_ISSUER: string;
  TEST_HOST_SIGNING_KEY: string;
  TEST_HOST_ADMIN_SECRET: string;
}

export async function createTestHostTestBindings(): Promise<TestHostTestBindings> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("ECDSA key generation returned no key pair");
  const signingKey = {
    kid: `test-host-test-${crypto.randomUUID()}`,
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  return {
    TEST_HOST_ISSUER: TEST_HOST_TEST_ISSUER,
    TEST_HOST_SIGNING_KEY: JSON.stringify(signingKey),
    TEST_HOST_ADMIN_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64url",
    ),
  };
}
