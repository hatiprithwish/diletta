import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Verifies the eval JWT (M5-2) the harness signs with the platform's eval key: decode (parse only, nothing
// trusted), verifySignature (EVAL_JWT_PUBLIC_JWKS, the platform's own public keys: no host JWKS is ever fetched) and
// checkClaims (iss, aud, exp, iat, lifetime). EvalHarnessRepo runs them before it reads anything the token names.
// WebCrypto here verifies the platform's own public signature, not company data, so it stays out of @app/crypto
// (pattern rule 3.19). The token itself is never logged. Never throws.
export default class EvalJwtProvider {
  static decode(token: string): Schemas.DecodeEvalJwtResponse {
    const response: Schemas.DecodeEvalJwtResponse = { isSuccess: false };

    try {
      const parts = token.length <= Schemas.EVAL_JWT_MAX_LENGTH ? token.split(".") : [];
      const [encodedHeader, encodedClaims, encodedSignature] = parts;
      if (
        parts.length !== 3 ||
        encodedHeader === undefined ||
        encodedClaims === undefined ||
        encodedSignature === undefined
      ) {
        return EvalJwtProvider.rejectDecode(response, "Token is not a compact JWS");
      }

      const header = Schemas.ZEvalJwtHeader.safeParse(EvalJwtProvider.decodeJson(encodedHeader));
      if (!header.success) {
        return EvalJwtProvider.rejectDecode(
          response,
          "Token header is invalid or its algorithm is not allowed",
          { issues: header.error.issues },
        );
      }

      const claims = Schemas.ZEvalJwtClaims.safeParse(EvalJwtProvider.decodeJson(encodedClaims));
      if (!claims.success) {
        return EvalJwtProvider.rejectDecode(response, "Token claims are invalid", {
          issues: claims.error.issues,
        });
      }

      const signature = Utility.decodeBase64Url(encodedSignature);
      if (signature === null || signature.byteLength === 0) {
        return EvalJwtProvider.rejectDecode(response, "Token signature is not base64url");
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
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.DecodeEvalJwt,
        message,
        error,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The key is the one EVAL_JWT_PUBLIC_JWKS lists under the token's kid (more than one during a rotation).
  // Unset or unreadable keys are a ServerError: no eval can run until the worker is configured.
  static async verifySignature(
    env: Env,
    jwt: Schemas.DecodedEvalJwt,
  ): Promise<Schemas.VerifyEvalJwtResponse> {
    const response: Schemas.VerifyEvalJwtResponse = { isSuccess: false };
    const metadata = { alg: jwt.header.alg, kid: jwt.header.kid };

    try {
      const jwks = Schemas.ZJwks.safeParse(Utility.parseJson(env.EVAL_JWT_PUBLIC_JWKS ?? ""));
      if (!jwks.success) {
        const message = "EVAL_JWT_PUBLIC_JWKS is unset or not a JWKS";
        AppLogger.error({
          category: Schemas.LogCategory.Eval,
          action: Schemas.LogAction.VerifyEvalJwt,
          message,
        });
        response.message = message;
        response.failure = Schemas.EvalAuthFailureEnum.ServerError;
        return response;
      }

      const jwk = jwks.data.keys.find(
        (key) =>
          key.kid === jwt.header.kid &&
          key.kty === "EC" &&
          key.crv === "P-256" &&
          (key.alg === undefined || key.alg === jwt.header.alg) &&
          (key.use === undefined || key.use === "sig"),
      );
      if (!jwk || jwk.x === undefined || jwk.y === undefined) {
        return EvalJwtProvider.rejectToken(response, "No eval key matches the token", metadata);
      }

      // DEV_NOTE: Rebuilt from the public members only, imported non-extractable and verify-only
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      // DEV_NOTE: An ES256 JWS signature is r ‖ s (64 bytes), the format WebCrypto's ECDSA verify takes as is
      const isValid =
        jwt.signature.byteLength === 64 &&
        (await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          jwt.signature,
          jwt.signingInput,
        ));
      if (!isValid) {
        return EvalJwtProvider.rejectToken(response, "Token signature is invalid", metadata);
      }

      response.isSuccess = true;
      response.message = "Token signature verified";
    } catch (error) {
      const message = "Unknown error in verifying token signature";
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.VerifyEvalJwt,
        message,
        error,
        metadata,
      });
      response.message = message;
      response.failure = Schemas.EvalAuthFailureEnum.ServerError;
    }

    return response;
  }

  // DEV_NOTE: Times are seconds since the epoch; exp, nbf and iat each get the clock skew. nowSeconds is a parameter
  // so tests can pin the clock.
  static checkClaims(
    claims: Schemas.EvalJwtClaims,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Schemas.VerifyEvalJwtResponse {
    const response: Schemas.VerifyEvalJwtResponse = { isSuccess: false };
    const metadata = { exp: claims.exp, iat: claims.iat, nowSeconds };
    const skew = Schemas.EVAL_JWT_CLOCK_SKEW_SECONDS;

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(Schemas.EVAL_JWT_AUDIENCE)) {
      return EvalJwtProvider.rejectToken(response, "Token audience is not the eval API", {
        ...metadata,
        aud: claims.aud,
      });
    }
    if (claims.exp + skew <= nowSeconds) {
      return EvalJwtProvider.rejectToken(response, "Token has expired", metadata);
    }
    if (claims.nbf !== undefined && claims.nbf - skew > nowSeconds) {
      return EvalJwtProvider.rejectToken(response, "Token is not valid yet", {
        ...metadata,
        nbf: claims.nbf,
      });
    }
    if (claims.iat - skew > nowSeconds) {
      return EvalJwtProvider.rejectToken(response, "Token is issued in the future", metadata);
    }
    if (
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > Schemas.EVAL_JWT_MAX_LIFETIME_SECONDS
    ) {
      return EvalJwtProvider.rejectToken(response, "Token lifetime is not allowed", metadata);
    }

    response.isSuccess = true;
    response.message = "Token claims are valid";
    return response;
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
    response: Schemas.DecodeEvalJwtResponse,
    message: string,
    metadata?: Record<string, unknown>,
  ): Schemas.DecodeEvalJwtResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.DecodeEvalJwt,
      message,
      metadata,
    });
    response.message = message;
    return response;
  }

  private static rejectToken(
    response: Schemas.VerifyEvalJwtResponse,
    message: string,
    metadata: Record<string, unknown>,
  ): Schemas.VerifyEvalJwtResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.VerifyEvalJwt,
      message,
      metadata,
    });
    response.message = message;
    response.failure = Schemas.EvalAuthFailureEnum.Unauthorized;
    return response;
  }
}
