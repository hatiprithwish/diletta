import * as Schemas from "@app/schemas";

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ES256_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const encodeJson = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));

function decodeJson(text: string): unknown {
  const bytes = base64UrlDecode(text);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// DEV_NOTE: The test host's own tokens, ES256 on WebCrypto with TEST_HOST_SIGNING_KEY. Not company data (the test host
// is a stand-in customer, outside the platform), so @app/crypto doesn't apply; mirrors apps/widget/scripts/devJwt.ts.
// Both tokens carry the same sub. The companion JWT is what the platform verifies (WidgetJwtProvider: alg, kid,
// iss, aud, ≤ 5 minutes); the host token is what jwt_forward sends back here, checked by verifyHostToken.
export default class TokenProvider {
  static readSigningKey(env: Env): Schemas.TestHostSigningKey | null {
    try {
      const parsed = Schemas.ZTestHostSigningKey.safeParse(JSON.parse(env.TEST_HOST_SIGNING_KEY));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // The JWKS entry: public members only, never d
  static getPublicJwk(key: Schemas.TestHostSigningKey): Schemas.Jwk {
    const { kty, crv, x, y } = key.privateJwk;
    return { kty, crv, x, y, kid: key.kid, alg: Schemas.WidgetJwtAlgorithmEnum.ES256, use: "sig" };
  }

  static async mint(
    env: Env,
    key: Schemas.TestHostSigningKey,
    request: Schemas.TestHostTokenRequest,
  ): Promise<Schemas.TestHostTokenResponse> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (request.expiresInSeconds ?? Schemas.TEST_HOST_TOKEN_LIFETIME_SECONDS);
    const companionClaims: Schemas.WidgetJwtClaims = {
      iss: env.TEST_HOST_ISSUER,
      sub: request.sub,
      aud: Schemas.WIDGET_JWT_AUDIENCE,
      iat,
      exp,
      ...(request.name !== undefined && { name: request.name }),
      ...(request.roles !== undefined && { roles: request.roles }),
    };
    const hostClaims: Schemas.TestHostTokenClaims = {
      iss: env.TEST_HOST_ISSUER,
      sub: request.sub,
      aud: Schemas.TEST_HOST_API_AUDIENCE,
      ws: request.workspace,
      iat,
      exp,
    };
    return {
      companionJwt: await TokenProvider.sign(key, companionClaims),
      hostToken: await TokenProvider.sign(key, hostClaims),
      expiresAt: exp,
    };
  }

  // DEV_NOTE: null on anything wrong (shape, alg, kid, signature, iss, aud, lifetime), so the route answers one 401
  static async verifyHostToken(
    env: Env,
    key: Schemas.TestHostSigningKey,
    token: string,
  ): Promise<Schemas.TestHostTokenClaims | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

    const header = Schemas.ZWidgetJwtHeader.safeParse(decodeJson(encodedHeader));
    if (
      !header.success ||
      header.data.alg !== Schemas.WidgetJwtAlgorithmEnum.ES256 ||
      header.data.kid !== key.kid
    ) {
      return null;
    }
    const signature = base64UrlDecode(encodedSignature);
    if (!signature) return null;

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      TokenProvider.getPublicJwk(key),
      ES256,
      false,
      ["verify"],
    );
    const isValid = await crypto.subtle.verify(
      ES256_SIGN,
      publicKey,
      signature,
      encoder.encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!isValid) return null;

    const claims = Schemas.ZTestHostTokenClaims.safeParse(decodeJson(encodedClaims));
    if (!claims.success || claims.data.iss !== env.TEST_HOST_ISSUER) return null;

    const now = Math.floor(Date.now() / 1000);
    if (claims.data.exp <= now) return null;
    if (claims.data.iat - Schemas.TEST_HOST_TOKEN_CLOCK_SKEW_SECONDS > now) return null;
    if (claims.data.exp - claims.data.iat > Schemas.TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS)
      return null;
    return claims.data;
  }

  private static async sign(key: Schemas.TestHostSigningKey, claims: object): Promise<string> {
    const privateKey = await crypto.subtle.importKey("jwk", key.privateJwk, ES256, false, ["sign"]);
    const header = { alg: Schemas.WidgetJwtAlgorithmEnum.ES256, kid: key.kid, typ: "JWT" };
    const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
    const signature = await crypto.subtle.sign(
      ES256_SIGN,
      privateKey,
      encoder.encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }
}
