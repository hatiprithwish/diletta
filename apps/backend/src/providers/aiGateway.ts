import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";

const GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

// DEV_NOTE: Provider-native gateway endpoints (llm-context/ai-gateway.md). The gateway forwards everything after the
// provider segment to the provider unchanged, so each path ends where the SDK's default base URL ends
// (api.anthropic.com/v1, api.openai.com/v1, generativelanguage.googleapis.com/v1beta).
const PROVIDER_PATH: Record<Schemas.ModelProviderEnum, string> = {
  [Schemas.ModelProviderEnum.Anthropic]: "anthropic/v1",
  [Schemas.ModelProviderEnum.OpenAI]: "openai",
  [Schemas.ModelProviderEnum.Google]: "google-ai-studio/v1beta",
};

// DEV_NOTE: One SDK factory per provider. A Record, so adding a provider to ModelProviderEnum fails to compile until
// it has a factory here (and a path above).
const PROVIDER_MODEL_FACTORY: Record<
  Schemas.ModelProviderEnum,
  (
    settings: { baseURL: string; apiKey: string; headers: Record<string, string> },
    model: string,
  ) => Parameters<typeof wrapLanguageModel>[0]["model"]
> = {
  [Schemas.ModelProviderEnum.Anthropic]: (settings, model) => createAnthropic(settings)(model),
  [Schemas.ModelProviderEnum.OpenAI]: (settings, model) => createOpenAI(settings)(model),
  [Schemas.ModelProviderEnum.Google]: (settings, model) => createGoogle(settings)(model),
};

const GATEWAY_LOG_ID_HEADER = "cf-aig-log-id";
// DEV_NOTE: The gateway keeps the first 5 metadata entries and drops the rest silently
const MAX_METADATA_ENTRIES = 5;

// DEV_NOTE: The only place a provider SDK is built and AI Gateway is called (pattern rule 3.10). No database, no
// transaction. The company key arrives decrypted from ModelRouterRepo and goes only into the SDK's own auth header
// (x-api-key, Authorization or x-goog-api-key) on requests to the gateway; it is never logged or returned. The gateway
// token is the platform's, from AI_GATEWAY_TOKEN (a Secrets Store binding in staging and production, a .dev.vars
// string locally): cf-aig-authorization on model calls, and the Bearer token for reading gateway logs, so it carries
// AI Gateway Run + Read (docs/runbooks/ai-gateway.md).
export default class AiGatewayProvider {
  static async createModel(
    env: Env,
    params: {
      provider: Schemas.ModelProviderEnum;
      model: string;
      apiKey: string;
      metadata: Record<string, string>;
      middleware: LanguageModelMiddleware;
    },
  ): Promise<Schemas.GetModelResponse<LanguageModel>> {
    const logMetadata = { provider: params.provider, model: params.model };

    try {
      const token = await AiGatewayProvider.getGatewayToken(env);
      if (!token || !env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME) {
        const message = "AI Gateway is not configured";
        AppLogger.error({
          category: Schemas.LogCategory.ModelRouter,
          action: Schemas.LogAction.CreateGatewayModel,
          message,
          metadata: logMetadata,
        });
        return { isSuccess: false, message, failure: Schemas.ModelRouterFailureEnum.ServerError };
      }

      const model = PROVIDER_MODEL_FACTORY[params.provider](
        {
          baseURL: `${GATEWAY_BASE_URL}/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/${PROVIDER_PATH[params.provider]}`,
          apiKey: params.apiKey,
          headers: {
            "cf-aig-authorization": `Bearer ${token}`,
            "cf-aig-metadata": JSON.stringify(
              Object.fromEntries(Object.entries(params.metadata).slice(0, MAX_METADATA_ENTRIES)),
            ),
          },
        },
        params.model,
      );

      return {
        isSuccess: true,
        message: "Gateway model created successfully",
        model: wrapLanguageModel({ model, middleware: params.middleware }),
      };
    } catch (error) {
      const message = "Unknown error in creating gateway model";
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.CreateGatewayModel,
        message,
        error,
        metadata: logMetadata,
      });
      return { isSuccess: false, message, failure: Schemas.ModelRouterFailureEnum.ServerError };
    }
  }

  // DEV_NOTE: Token counts from the gateway's log of one call (Cloudflare API, AI Gateway Read), for the usage
  // backfill. isNotFound while the log doesn't exist (it may not be written yet); hasUsage false when it exists
  // without token counts. Never throws.
  static async getLogUsage(
    env: Env,
    gatewayLogId: string,
  ): Promise<Schemas.GatewayLogUsageResponse> {
    const response: Schemas.GatewayLogUsageResponse = { isSuccess: false };
    const metadata = { gatewayLogId };

    try {
      const token = await AiGatewayProvider.getGatewayToken(env);
      if (!token || !env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME) {
        const message = "AI Gateway is not configured";
        AppLogger.error({
          category: Schemas.LogCategory.ModelRouter,
          action: Schemas.LogAction.GetGatewayLogUsage,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const url = `${CLOUDFLARE_API_BASE_URL}/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_NAME}/logs/${encodeURIComponent(gatewayLogId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(Constants.AI_GATEWAY_LOG_FETCH_TIMEOUT_MS),
      });

      if (res.status === 404) {
        await res.body?.cancel();
        response.message = "Gateway log not found";
        response.isNotFound = true;
        return response;
      }
      if (!res.ok) {
        await res.body?.cancel();
        const message = `Gateway log request failed with status ${res.status}`;
        AppLogger.error({
          category: Schemas.LogCategory.ModelRouter,
          action: Schemas.LogAction.GetGatewayLogUsage,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const parsed = Schemas.ZAiGatewayLogResponse.safeParse(await res.json());
      if (!parsed.success || !parsed.data.success) {
        const message = "Gateway log response is malformed";
        AppLogger.error({
          category: Schemas.LogCategory.ModelRouter,
          action: Schemas.LogAction.GetGatewayLogUsage,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const inputTokens = parsed.data.result?.tokens_in ?? 0;
      const outputTokens = parsed.data.result?.tokens_out ?? 0;
      response.isSuccess = true;
      response.message = "Gateway log usage fetched successfully";
      // DEV_NOTE: A call the provider billed always has a prompt, so 0 input tokens means the log has no count
      response.hasUsage = inputTokens > 0;
      response.inputTokens = inputTokens;
      response.outputTokens = outputTokens;
    } catch (error) {
      const message = "Unknown error in fetching gateway log usage";
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.GetGatewayLogUsage,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The gateway's id for the call's log entry (model_calls.gateway_log_id), from the response headers
  static getGatewayLogId(headers: Record<string, string | undefined> | undefined): string | null {
    return headers?.[GATEWAY_LOG_ID_HEADER] ?? null;
  }

  // DEV_NOTE: Same, for a call that failed with an HTTP answer (the headers ride on the APICallError)
  static getGatewayLogIdFromError(error: unknown): string | null {
    return APICallError.isInstance(error)
      ? AiGatewayProvider.getGatewayLogId(error.responseHeaders)
      : null;
  }

  // DEV_NOTE: True when the provider (or the gateway) answered the call with an error status. Providers don't bill a
  // request they refuse, so such a call has no usage to recover. Anything else (connection lost, timeout, abort, an
  // unreadable body) may have been billed.
  static isRefusedCall(error: unknown): boolean {
    return APICallError.isInstance(error) && error.statusCode !== undefined;
  }

  // DEV_NOTE: True only when the provider itself said the company's key is bad, matched on the provider's own error
  // shape. A gateway error (bad cf-aig token, gateway rate limit or spend limit) has an `error` array instead and never
  // matches, so a platform misconfiguration can't invalidate every company's key. 403s (Anthropic permission_error,
  // Google PERMISSION_DENIED) mean a valid key can't use this model or the API isn't enabled: a config problem, not a
  // bad key, so they never invalidate it. Google answers an invalid key with 400 API_KEY_INVALID, hence per-provider
  // rules.
  static isRejectedKeyError(provider: Schemas.ModelProviderEnum, error: unknown): boolean {
    if (!APICallError.isInstance(error) || error.statusCode === undefined) {
      return false;
    }
    const providerError = AiGatewayProvider.readProviderError(error.responseBody);
    if (!providerError) {
      return false;
    }

    switch (provider) {
      case Schemas.ModelProviderEnum.Anthropic:
        return error.statusCode === 401 && providerError.type === "authentication_error";
      case Schemas.ModelProviderEnum.OpenAI:
        return error.statusCode === 401;
      case Schemas.ModelProviderEnum.Google:
        return (
          (error.statusCode === 400 && providerError.reasons.includes("API_KEY_INVALID")) ||
          (error.statusCode === 401 && providerError.status === "UNAUTHENTICATED")
        );
    }
  }

  // DEV_NOTE: model_calls.error_code for a failed call: the HTTP status when the provider or gateway answered,
  // "aborted" when the caller stopped it, else the error's name. Never the message, which can echo the prompt.
  static getErrorCode(error: unknown): string {
    if (APICallError.isInstance(error) && error.statusCode !== undefined) {
      return `http_${error.statusCode}`;
    }
    if (error instanceof Error) {
      return error.name === "AbortError" ? "aborted" : error.name;
    }
    return "unknown";
  }

  // DEV_NOTE: The SDK's usage → our counts. Providers leave fields undefined when they don't report them.
  static toModelCallUsage(usage: {
    inputTokens: {
      total: number | undefined;
      cacheRead: number | undefined;
      cacheWrite: number | undefined;
    };
    outputTokens: { total: number | undefined };
  }): Schemas.ModelCallUsage {
    return {
      inputTokens: usage.inputTokens.total ?? 0,
      cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
      cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
      outputTokens: usage.outputTokens.total ?? 0,
    };
  }

  private static async getGatewayToken(env: Env): Promise<string | null> {
    const source = env.AI_GATEWAY_TOKEN;
    if (!source) return null;
    const token = typeof source === "string" ? source : await source.get();
    return token.trim() || null;
  }

  // DEV_NOTE: The provider's error object: { error: { type } } (Anthropic), { error: { code, type } } (OpenAI),
  // { error: { status, details: [{ reason }] } } (Google). null when the body isn't JSON or `error` isn't an object
  // (the gateway's own errors carry an array).
  private static readProviderError(
    responseBody: string | undefined,
  ): { type: string | null; status: string | null; reasons: string[] } | null {
    if (!responseBody) return null;
    let body: unknown;
    try {
      body = JSON.parse(responseBody);
    } catch {
      return null;
    }
    if (typeof body !== "object" || body === null || !("error" in body)) return null;
    const providerError = body.error;
    if (
      typeof providerError !== "object" ||
      providerError === null ||
      Array.isArray(providerError)
    ) {
      return null;
    }

    const type =
      "type" in providerError && typeof providerError.type === "string" ? providerError.type : null;
    const status =
      "status" in providerError && typeof providerError.status === "string"
        ? providerError.status
        : null;
    const reasons: string[] = [];
    if ("details" in providerError && Array.isArray(providerError.details)) {
      for (const detail of providerError.details as unknown[]) {
        if (typeof detail === "object" && detail !== null && "reason" in detail) {
          if (typeof detail.reason === "string") reasons.push(detail.reason);
        }
      }
    }
    return { type, status, reasons };
  }
}
