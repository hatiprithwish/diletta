import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

const GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

// DEV_NOTE: Provider-native gateway endpoints (llm-context/ai-gateway.md). The gateway forwards everything after the
// provider segment to the provider unchanged, so each path ends where the SDK's default base URL ends
// (api.anthropic.com/v1, api.openai.com/v1, generativelanguage.googleapis.com/v1beta).
const PROVIDER_PATH: Record<Schemas.ModelProviderEnum, string> = {
  [Schemas.ModelProviderEnum.Anthropic]: "anthropic/v1",
  [Schemas.ModelProviderEnum.OpenAI]: "openai",
  [Schemas.ModelProviderEnum.Google]: "google-ai-studio/v1beta",
};

const GATEWAY_LOG_ID_HEADER = "cf-aig-log-id";
// DEV_NOTE: The gateway keeps the first 5 metadata entries and drops the rest silently
const MAX_METADATA_ENTRIES = 5;

// DEV_NOTE: The only place a provider SDK is built (pattern rule 3.10). Pure: no database, no transaction. The
// company key arrives decrypted from ModelRouterRepo and goes only into the SDK's own auth header (x-api-key,
// Authorization or x-goog-api-key) on requests to the gateway; it is never logged or returned. The gateway token
// (cf-aig-authorization) is the platform's, from AI_GATEWAY_TOKEN: a Secrets Store binding in staging and production,
// a .dev.vars string locally (docs/runbooks/ai-gateway.md).
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
    const response: Schemas.GetModelResponse<LanguageModel> = { isSuccess: false };
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
        response.message = message;
        response.failure = Schemas.ModelRouterFailureEnum.ServerError;
        return response;
      }

      const settings = {
        baseURL: `${GATEWAY_BASE_URL}/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/${PROVIDER_PATH[params.provider]}`,
        apiKey: params.apiKey,
        headers: {
          "cf-aig-authorization": `Bearer ${token}`,
          "cf-aig-metadata": JSON.stringify(
            Object.fromEntries(Object.entries(params.metadata).slice(0, MAX_METADATA_ENTRIES)),
          ),
        },
      };

      const model =
        params.provider === Schemas.ModelProviderEnum.Anthropic
          ? createAnthropic(settings)(params.model)
          : params.provider === Schemas.ModelProviderEnum.OpenAI
            ? createOpenAI(settings)(params.model)
            : createGoogle(settings)(params.model);

      response.isSuccess = true;
      response.message = "Gateway model created successfully";
      response.model = wrapLanguageModel({ model, middleware: params.middleware });
    } catch (error) {
      const message = "Unknown error in creating gateway model";
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.CreateGatewayModel,
        message,
        error,
        metadata: logMetadata,
      });
      response.message = message;
      response.failure = Schemas.ModelRouterFailureEnum.ServerError;
    }

    return response;
  }

  // DEV_NOTE: The gateway's id for the call's log entry (model_calls.gateway_log_id), from the response headers
  static getGatewayLogId(headers: Record<string, string | undefined> | undefined): string | null {
    return headers?.[GATEWAY_LOG_ID_HEADER] ?? null;
  }

  // DEV_NOTE: True only when the provider itself said the company's key is bad, matched on the provider's own error
  // shape. A gateway error (bad cf-aig token, gateway rate limit) has an `error` array instead and never matches, so a
  // platform misconfiguration can't invalidate every company's key. Google answers an invalid key with 400
  // API_KEY_INVALID rather than 401, hence the per-provider rules.
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
        return (
          (error.statusCode === 401 && providerError.type === "authentication_error") ||
          (error.statusCode === 403 && providerError.type === "permission_error")
        );
      case Schemas.ModelProviderEnum.OpenAI:
        return error.statusCode === 401;
      case Schemas.ModelProviderEnum.Google:
        return (
          (error.statusCode === 400 && providerError.reasons.includes("API_KEY_INVALID")) ||
          ((error.statusCode === 401 || error.statusCode === 403) &&
            (providerError.status === "UNAUTHENTICATED" ||
              providerError.status === "PERMISSION_DENIED"))
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
