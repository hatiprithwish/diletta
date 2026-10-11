import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "@/index";
import * as Schemas from "@app/schemas";
import { adminHeaders, api, decodePart, mintTokens, newWorkspace } from "@/tests/helpers";

describe("JWKS", () => {
  it("serves the public signing key only", async () => {
    const response = await app.request("/.well-known/jwks.json", {}, env);
    expect(response.status).toBe(200);
    const jwks = Schemas.ZJwks.parse(await response.json());
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("answers 503 when the signing key is missing", async () => {
    const response = await app.request(
      "/.well-known/jwks.json",
      {},
      { ...env, TEST_HOST_SIGNING_KEY: "not json" },
    );
    expect(response.status).toBe(503);
  });
});

describe("POST /auth/tokens", () => {
  it("is admin only", async () => {
    const body = JSON.stringify({ workspace: newWorkspace(), sub: "u1" });
    const missing = await app.request("/auth/tokens", { method: "POST", body }, env);
    expect(missing.status).toBe(401);
    const wrong = await app.request(
      "/auth/tokens",
      {
        method: "POST",
        body,
        headers: { ...adminHeaders(), [Schemas.TEST_HOST_ADMIN_HEADER]: "nope" },
      },
      env,
    );
    expect(wrong.status).toBe(401);
  });

  it("refuses a request that doesn't parse, without echoing it", async () => {
    const response = await app.request(
      "/auth/tokens",
      { method: "POST", headers: adminHeaders(), body: JSON.stringify({ workspace: "a b" }) },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  });

  it("mints a companion JWT the platform accepts and a host token for the workspace", async () => {
    const workspace = newWorkspace();
    const tokens = await mintTokens(workspace, { sub: "user_9", name: "Ada", roles: ["admin"] });

    const header = Schemas.ZWidgetJwtHeader.parse(decodePart(tokens.companionJwt, 0));
    expect(header.alg).toBe(Schemas.WidgetJwtAlgorithmEnum.ES256);
    const companion = Schemas.ZWidgetJwtClaims.parse(decodePart(tokens.companionJwt, 1));
    expect(companion).toMatchObject({
      iss: env.TEST_HOST_ISSUER,
      sub: "user_9",
      aud: Schemas.WIDGET_JWT_AUDIENCE,
      name: "Ada",
      roles: ["admin"],
    });
    expect(companion.exp - companion.iat).toBe(Schemas.TEST_HOST_TOKEN_LIFETIME_SECONDS);
    expect(tokens.expiresAt).toBe(companion.exp);

    const host = Schemas.ZTestHostTokenClaims.parse(decodePart(tokens.hostToken, 1));
    expect(host).toMatchObject({ sub: "user_9", ws: workspace, iss: env.TEST_HOST_ISSUER });
  });
});

describe("host token on /v1", () => {
  it("accepts the host token, with the scheme in any case", async () => {
    const { hostToken } = await mintTokens(newWorkspace());
    const response = await app.request(
      "/v1/records",
      { headers: { Authorization: `bEaReR ${hostToken}` } },
      env,
    );
    expect(response.status).toBe(200);
  });

  it("refuses no token, the companion JWT, an expired, a tampered and a foreign token", async () => {
    const workspace = newWorkspace();
    const { hostToken, companionJwt } = await mintTokens(workspace);
    const expired = await mintTokens(workspace, { expiresInSeconds: -10 });
    // Same signature over a payload moved to another workspace
    const [head, , signature] = hostToken.split(".");
    const claims = Schemas.ZTestHostTokenClaims.parse(decodePart(hostToken, 1));
    const payload = btoa(JSON.stringify({ ...claims, ws: "other" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${head}.${payload}.${signature}`;

    for (const token of [undefined, companionJwt, expired.hostToken, forged, "a.b.c"]) {
      const response = await api("GET", "/v1/records", { token });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("refuses a token signed by another key", async () => {
    const { hostToken } = await mintTokens(newWorkspace());
    const otherKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in otherKey)) throw new Error("No key pair");
    const response = await app.request(
      "/v1/records",
      { headers: { Authorization: `Bearer ${hostToken}` } },
      {
        ...env,
        TEST_HOST_SIGNING_KEY: JSON.stringify({
          kid: Schemas.ZTestHostSigningKey.parse(JSON.parse(env.TEST_HOST_SIGNING_KEY)).kid,
          privateJwk: await crypto.subtle.exportKey("jwk", otherKey.privateKey),
        }),
      },
    );
    expect(response.status).toBe(401);
  });
});
