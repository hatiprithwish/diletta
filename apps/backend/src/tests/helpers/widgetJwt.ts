import { env } from "cloudflare:test";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";

// DEV_NOTE: Companion JWT fixtures shared by the widget suites: keys generated per run, tokens signed with them, and
// each issuer's JWKS seeded straight into the JWKS_CACHE KV (miniflare), so no test fetches a real JWKS.
export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const encodeJson = (value: unknown) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

export async function createKey(
  alg: Schemas.WidgetJwtAlgorithmEnum,
  kid: string,
  modulusLength = 2048,
) {
  const pair = (await crypto.subtle.generateKey(
    alg === Schemas.WidgetJwtAlgorithmEnum.RS256
      ? {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        }
      : { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    jwk: Schemas.ZJwk.parse({ ...publicJwk, kid, alg, use: "sig" }),
  };
}

export function claimsFor(issuer: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    sub: "host-user-1",
    aud: Schemas.WIDGET_JWT_AUDIENCE,
    iat: now,
    exp: now + 120,
    roles: ["editor"],
    name: "Ada",
    ...overrides,
  };
}

export async function signToken(
  key: Awaited<ReturnType<typeof createKey>>,
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = { alg: key.alg, kid: key.kid, typ: "JWT", ...headerOverrides };
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    key.alg === Schemas.WidgetJwtAlgorithmEnum.RS256
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

export async function seedJwks(issuer: string, keys: Schemas.Jwk[], fetchedAt = Date.now()) {
  await env.JWKS_CACHE.put(
    `${Constants.JWKS_CACHE_KEY_PREFIX}${issuer}`,
    JSON.stringify({ keys, fetchedAt }),
    { expirationTtl: Constants.JWKS_CACHE_TTL_SECONDS },
  );
}
