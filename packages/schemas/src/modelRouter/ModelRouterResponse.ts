import type { ApiResponse } from "../common";
import type { CompanySecret, DecryptedCompanySecretResponse } from "../companySecrets";
import type { ModelRouterFailureEnum } from "./ModelRouterCommon";

// DEV_NOTE: Server-side only (never crosses an API). TModel is the AI SDK LanguageModel, which @app/schemas doesn't
// depend on, so the backend fills it in. A union, so a failure always carries its reason and a success its model:
// the caller shows every failure as MODEL_UNAVAILABLE_MESSAGE.
export type GetModelResponse<TModel> =
  | (ApiResponse & { isSuccess: true; model: TModel; failure?: undefined })
  | (ApiResponse & { isSuccess: false; model?: undefined; failure: ModelRouterFailureEnum });

// DEV_NOTE: Server-side only (ModelRouterRepo key lookup). secret is the decrypted company model key: it goes to the
// gateway provider and nowhere else. companySecret identifies exactly which value was used (iv + key version change on
// every replacement), so a late rejection can only invalidate that value, never one the admin put in since.
export interface DecryptedModelKeyResponse extends DecryptedCompanySecretResponse {
  companySecret?: Pick<CompanySecret, "publicId" | "iv" | "encryptionKeyVersion">;
}

// DEV_NOTE: Server-side only (ModelRouterRepo key-failure path). qualityIssueId and outboxId are set when this
// failure opened the company's system issue; they stay unset when one was already open (its note may have been
// extended), the call had no conversation, or the key had changed since the call. outboxId is relayed after commit.
export interface HandleModelKeyFailureResponse extends ApiResponse {
  qualityIssueId?: string;
  outboxId?: string;
}

// DEV_NOTE: Server-side only (AiGatewayProvider.getLogUsage). Token counts from one AI Gateway log; isNotFound when
// the log doesn't exist (yet), hasUsage false when it exists without token counts.
export interface GatewayLogUsageResponse extends ApiResponse {
  hasUsage?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

// DEV_NOTE: Server-side only (Cron → ModelCallsRepo.backfillPendingUsage)
export interface BackfillModelCallUsageResponse extends ApiResponse {
  backfilledCount?: number;
  unknownCount?: number;
  stillPendingCount?: number;
}
