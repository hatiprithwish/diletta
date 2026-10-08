import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";

// DEV_NOTE: An issuer's public signing keys, from {iss}/.well-known/jwks.json, cached in the JWKS_CACHE KV namespace.
// Only ever called with the jwt_issuer of a company_connections row (WidgetAuthRepo looks the issuer up first), so
// a token can't make the worker fetch a URL no company registered. Never throws.
export default class JwksProvider {
  // DEV_NOTE: The cached set, or a fresh fetch when nothing is cached (or the cached value no longer parses)
  static async getJwks(env: Env, issuer: string): Promise<Schemas.JwksResponse> {
    const cached = await JwksProvider.readCache(env, issuer);
    if (cached) {
      return { isSuccess: true, message: "JWKS read from cache", jwks: cached };
    }
    return await JwksProvider.fetchJwks(env, issuer);
  }

  // DEV_NOTE: A token's kid is missing from the cached set: the host may have rotated its keys, so fetch again, unless
  // the cached set is younger than JWKS_REFETCH_MIN_INTERVAL_MS. Then the cached set is the answer, which caps the
  // fetches a stream of made-up kids can cause at one per interval per issuer.
  static async refreshJwks(env: Env, issuer: string): Promise<Schemas.JwksResponse> {
    const cached = await JwksProvider.readCache(env, issuer);
    if (cached && Date.now() - cached.fetchedAt < Constants.JWKS_REFETCH_MIN_INTERVAL_MS) {
      return { isSuccess: true, message: "JWKS fetched recently, refetch skipped", jwks: cached };
    }
    return await JwksProvider.fetchJwks(env, issuer);
  }

  static getJwksUrl(issuer: string): string {
    return `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  }

  private static getCacheKey(issuer: string): string {
    return `${Constants.JWKS_CACHE_KEY_PREFIX}${issuer}`;
  }

  private static async readCache(env: Env, issuer: string): Promise<Schemas.CachedJwks | null> {
    try {
      const value = await env.JWKS_CACHE.get(JwksProvider.getCacheKey(issuer), "json");
      if (value === null) return null;

      const parsed = Schemas.ZCachedJwks.safeParse(value);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      // DEV_NOTE: A KV read failure falls through to a fetch, so a KV outage doesn't block every widget sign-in
      AppLogger.error({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.GetJwks,
        message: "Unknown error in reading cached JWKS",
        error,
        metadata: { issuer },
      });
      return null;
    }
  }

  private static async fetchJwks(env: Env, issuer: string): Promise<Schemas.JwksResponse> {
    const response: Schemas.JwksResponse = { isSuccess: false };
    const url = JwksProvider.getJwksUrl(issuer);

    try {
      // DEV_NOTE: No redirects: the keys must come from the issuer's own origin, over https (jwt_issuer is https-only)
      const fetched = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(Constants.JWKS_FETCH_TIMEOUT_MS),
      });

      if (!fetched.ok) {
        const message = "Issuer JWKS request failed";
        AppLogger.error({
          category: Schemas.LogCategory.Widget,
          action: Schemas.LogAction.GetJwks,
          message,
          metadata: { issuer, url, status: fetched.status },
        });
        response.message = message;
        return response;
      }

      const body = await fetched.text();
      if (body.length > Constants.JWKS_MAX_BYTES) {
        const message = "Issuer JWKS is too large";
        AppLogger.error({
          category: Schemas.LogCategory.Widget,
          action: Schemas.LogAction.GetJwks,
          message,
          metadata: { issuer, url, length: body.length },
        });
        response.message = message;
        return response;
      }

      const parsed = Schemas.ZJwks.safeParse(JSON.parse(body));
      if (!parsed.success) {
        const message = "Issuer JWKS is not a valid key set";
        AppLogger.error({
          category: Schemas.LogCategory.Widget,
          action: Schemas.LogAction.GetJwks,
          message,
          metadata: { issuer, url, issues: parsed.error.issues },
        });
        response.message = message;
        return response;
      }

      const jwks: Schemas.CachedJwks = { keys: parsed.data.keys, fetchedAt: Date.now() };
      await JwksProvider.writeCache(env, issuer, jwks);

      response.isSuccess = true;
      response.message = "JWKS fetched successfully";
      response.jwks = jwks;
    } catch (error) {
      const message = "Unknown error in fetching issuer JWKS";
      AppLogger.error({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.GetJwks,
        message,
        error,
        metadata: { issuer, url },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A KV write failure doesn't fail the sign-in: the fetched keys are still good, the next sign-in fetches
  // again
  private static async writeCache(env: Env, issuer: string, jwks: Schemas.CachedJwks) {
    try {
      await env.JWKS_CACHE.put(JwksProvider.getCacheKey(issuer), JSON.stringify(jwks), {
        expirationTtl: Constants.JWKS_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.GetJwks,
        message: "Unknown error in caching JWKS",
        error,
        metadata: { issuer },
      });
    }
  }
}
