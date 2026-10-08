import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import JwksProvider from "@/providers/jwks";
import Utility from "@/utils/Utility";

// DEV_NOTE: Verifies the companion JWT a host backend signs for its widget user. Three steps, which WidgetAuthRepo
// runs with the connection lookup in between: decode (parse only, nothing trusted), verifySignature (the issuer's
// JWKS) and checkClaims (aud, exp, iat, lifetime). WebCrypto here verifies a host's public signature, not company
// data, so it stays out of @app/crypto (pattern rule 3.19). The token itself is never logged. Never throws.
export default class WidgetJwtProvider {
  static decode(token: string): Schemas.DecodeWidgetJwtResponse {
    const response: Schemas.DecodeWidgetJwtResponse = { isSuccess: false };

    try {
      const parts = token.length <= Constants.WIDGET_JWT_MAX_LENGTH ? token.split(".") : [];
      const [encodedHeader, encodedClaims, encodedSignature] = parts;
      if (
        parts.length !== 3 ||
        encodedHeader === undefined ||
        encodedClaims === undefined ||
        encodedSignature === undefined
      ) {
        return WidgetJwtProvider.rejectDecode(response, "Token is not a compact JWS");
      }

      const header = Schemas.ZWidgetJwtHeader.safeParse(
        WidgetJwtProvider.decodeJson(encodedHeader),
      );
      if (!header.success) {
        return WidgetJwtProvider.rejectDecode(
          response,
          "Token header is invalid or its algorithm is not allowed",
          { issues: header.error.issues },
        );
      }

      const claims = Schemas.ZWidgetJwtClaims.safeParse(
        WidgetJwtProvider.decodeJson(encodedClaims),
      );
      if (!claims.success) {
        return WidgetJwtProvider.rejectDecode(response, "Token claims are invalid", {
          issues: claims.error.issues,
        });
      }

      const signature = Utility.decodeBase64Url(encodedSignature);
      if (signature === null || signature.byteLength === 0) {
        return WidgetJwtProvider.rejectDecode(response, "Token signature is not base64url");
      }

      response.isSuccess = true;
      response.message = "Token decoded successfully";
      response.jwt = {
        header: header.data,
        claims: claims.data,
        // DEV_NOTE: Copied into an ArrayBuffer-backed view, the type WebCrypto takes
        signingInput: new Uint8Array(new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)),
        signature,
      };
    } catch (error) {
      const message = "Unknown error in decoding token";
      AppLogger.error({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.DecodeWidgetJwt,
        message,
        error,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: issuer is the connection row's jwt_issuer, which equals the token's iss (that is how the row was found)
  static async verifySignature(
    env: Env,
    issuer: string,
    jwt: Schemas.DecodedWidgetJwt,
  ): Promise<Schemas.VerifyWidgetJwtResponse> {
    const response: Schemas.VerifyWidgetJwtResponse = { isSuccess: false };
    const metadata = { issuer, alg: jwt.header.alg, kid: jwt.header.kid };

    try {
      const jwks = await JwksProvider.getJwks(env, issuer);
      if (!jwks.isSuccess || !jwks.jwks) {
        response.message = jwks.message;
        response.failure = Schemas.WidgetAuthFailureEnum.ServerError;
        return response;
      }

      let jwk = WidgetJwtProvider.selectKey(jwks.jwks.keys, jwt.header);
      if (!jwk) {
        const refreshed = await JwksProvider.refreshJwks(env, issuer);
        if (!refreshed.isSuccess || !refreshed.jwks) {
          response.message = refreshed.message;
          response.failure = Schemas.WidgetAuthFailureEnum.ServerError;
          return response;
        }
        jwk = WidgetJwtProvider.selectKey(refreshed.jwks.keys, jwt.header);
      }
      if (!jwk) {
        return WidgetJwtProvider.rejectToken(response, "No issuer key matches the token", metadata);
      }

      const key = await WidgetJwtProvider.importKey(jwk, jwt.header.alg);
      if (!key) {
        return WidgetJwtProvider.rejectToken(response, "Issuer key can't be used", metadata);
      }

      const isValid = await WidgetJwtProvider.verify(key, jwt);
      if (!isValid) {
        return WidgetJwtProvider.rejectToken(response, "Token signature is invalid", metadata);
      }

      response.isSuccess = true;
      response.message = "Token signature verified";
    } catch (error) {
      const message = "Unknown error in verifying token signature";
      AppLogger.error({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.VerifyWidgetJwt,
        message,
        error,
        metadata,
      });
      response.message = message;
      response.failure = Schemas.WidgetAuthFailureEnum.ServerError;
    }

    return response;
  }

  // DEV_NOTE: Times are seconds since the epoch (NumericDate); exp, nbf and iat each get the clock skew. nowSeconds is a parameter so tests can pin the clock.
  static checkClaims(
    claims: Schemas.WidgetJwtClaims,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Schemas.VerifyWidgetJwtResponse {
    const response: Schemas.VerifyWidgetJwtResponse = { isSuccess: false };
    const metadata = { issuer: claims.iss, exp: claims.exp, iat: claims.iat, nowSeconds };
    const skew = Constants.WIDGET_JWT_CLOCK_SKEW_SECONDS;

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(Schemas.WIDGET_JWT_AUDIENCE)) {
      return WidgetJwtProvider.rejectToken(response, "Token audience is not the widget", {
        ...metadata,
        aud: claims.aud,
      });
    }
    if (claims.exp + skew <= nowSeconds) {
      return WidgetJwtProvider.rejectToken(response, "Token has expired", metadata);
    }
    if (claims.nbf !== undefined && claims.nbf - skew > nowSeconds) {
      return WidgetJwtProvider.rejectToken(response, "Token is not valid yet", {
        ...metadata,
        nbf: claims.nbf,
      });
    }
    if (claims.iat - skew > nowSeconds) {
      return WidgetJwtProvider.rejectToken(response, "Token is issued in the future", metadata);
    }
    if (
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > Constants.WIDGET_JWT_MAX_LIFETIME_SECONDS
    ) {
      return WidgetJwtProvider.rejectToken(response, "Token lifetime is not allowed", metadata);
    }

    response.isSuccess = true;
    response.message = "Token claims are valid";
    return response;
  }

  // DEV_NOTE: The key must match the token's kid and fit its alg: kty (and curve), and alg / use when the issuer
  // states them. A key published for another algorithm is never tried, so alg can't be swapped under a key.
  private static selectKey(
    keys: Schemas.Jwk[],
    header: Schemas.WidgetJwtHeader,
  ): Schemas.Jwk | undefined {
    return keys.find((key) => {
      if (key.kid !== header.kid) return false;
      if (key.alg !== undefined && key.alg !== header.alg) return false;
      if (key.use !== undefined && key.use !== "sig") return false;
      switch (header.alg) {
        case Schemas.WidgetJwtAlgorithmEnum.RS256:
          return key.kty === "RSA";
        case Schemas.WidgetJwtAlgorithmEnum.ES256:
          return key.kty === "EC" && key.crv === "P-256";
      }
    });
  }

  // DEV_NOTE: Rebuilt from the public members only (never d, p, q…) and imported non-extractable, verify-only.
  // null = the issuer published a key WebCrypto can't use, or an RSA key under 2048 bits.
  private static async importKey(
    jwk: Schemas.Jwk,
    alg: Schemas.WidgetJwtAlgorithmEnum,
  ): Promise<CryptoKey | null> {
    try {
      switch (alg) {
        case Schemas.WidgetJwtAlgorithmEnum.RS256: {
          const modulus = jwk.n === undefined ? null : Utility.decodeBase64Url(jwk.n);
          if (
            modulus === null ||
            jwk.e === undefined ||
            modulus.byteLength < Constants.WIDGET_JWT_MIN_RSA_MODULUS_BYTES
          ) {
            return null;
          }
          return await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
        }
        case Schemas.WidgetJwtAlgorithmEnum.ES256: {
          if (jwk.x === undefined || jwk.y === undefined) {
            return null;
          }
          return await crypto.subtle.importKey(
            "jwk",
            { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          );
        }
      }
    } catch {
      return null;
    }
  }

  // DEV_NOTE: An ES256 JWS signature is r ‖ s (64 bytes), the format WebCrypto's ECDSA verify takes as is
  private static async verify(key: CryptoKey, jwt: Schemas.DecodedWidgetJwt): Promise<boolean> {
    switch (jwt.header.alg) {
      case Schemas.WidgetJwtAlgorithmEnum.RS256:
        return await crypto.subtle.verify(
          { name: "RSASSA-PKCS1-v1_5" },
          key,
          jwt.signature,
          jwt.signingInput,
        );
      case Schemas.WidgetJwtAlgorithmEnum.ES256:
        if (jwt.signature.byteLength !== 64) return false;
        return await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          jwt.signature,
          jwt.signingInput,
        );
    }
  }

  private static decodeJson(encoded: string): unknown {
    const bytes = Utility.decodeBase64Url(encoded);
    if (bytes === null) return null;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return null;
    }
  }

  private static rejectDecode(
    response: Schemas.DecodeWidgetJwtResponse,
    message: string,
    metadata?: Record<string, unknown>,
  ): Schemas.DecodeWidgetJwtResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Widget,
      action: Schemas.LogAction.DecodeWidgetJwt,
      message,
      metadata,
    });
    response.message = message;
    return response;
  }

  private static rejectToken(
    response: Schemas.VerifyWidgetJwtResponse,
    message: string,
    metadata: Record<string, unknown>,
  ): Schemas.VerifyWidgetJwtResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Widget,
      action: Schemas.LogAction.VerifyWidgetJwt,
      message,
      metadata,
    });
    response.message = message;
    response.failure = Schemas.WidgetAuthFailureEnum.Unauthorized;
    return response;
  }
}
