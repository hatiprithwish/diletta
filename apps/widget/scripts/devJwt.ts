import { readFile } from "node:fs/promises";
import path from "node:path";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Development only: the dev host's companion JWTs (see WIDGET_DEV_* in @app/schemas). Signed ES256 with
// the local key dev:setup made, ≤ 5 minutes like any host's, for one fixed test user.
export const DEV_KEY_PATH = path.resolve(import.meta.dirname, "../.dev/dev-key.json");
const TOKEN_LIFETIME_SECONDS = 240;

const base64Url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

export async function loadDevKey(): Promise<Schemas.WidgetDevKey | null> {
  try {
    const parsed = Schemas.ZWidgetDevKey.safeParse(
      JSON.parse(await readFile(DEV_KEY_PATH, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function signDevToken(
  devKey: Schemas.WidgetDevKey,
  user: Schemas.WidgetDevUser,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    devKey.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: Schemas.WidgetJwtAlgorithmEnum.ES256, kid: devKey.kid, typ: "JWT" };
  const claims = {
    iss: devKey.issuer,
    sub: user.sub,
    aud: Schemas.WIDGET_JWT_AUDIENCE,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
    name: user.name,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
