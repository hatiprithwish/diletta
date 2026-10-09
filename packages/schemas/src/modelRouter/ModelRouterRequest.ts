import type { CompanySecret, ModelProviderEnum } from "../companySecrets";
import type { ConfigSpec, ModelTierEnum } from "../configSpec";
import type { ModelCallUsageStatusIntEnum, ModelTaskTypeEnum } from "../modelCalls";
import type { ModelCallUsage, ModelKeyFailureReasonEnum, ModelPrice } from "./ModelRouterCommon";

// DEV_NOTE: Server-side only: never crosses an API, hence no "Api" in the file name. Called by the Conversation DO and
// the eval runner (ModelRouterRepo.getModel). Every id is internal and resolved server-side (WidgetIdentity, the
// conversation row). chatbotId / chatbotUserId / conversationId are null for a background job, evalRunId for anything
// but an eval. tier null = the routing's defaultTier. routing comes from the chatbot's loaded config spec
// (loadConfigSpec), so the router never reads chatbot_configs itself.
export interface GetModelRequest {
  companyId: string;
  chatbotId: string | null;
  chatbotUserId: string | null;
  conversationId: string | null;
  evalRunId: string | null;
  turnId: string | null;
  taskType: ModelTaskTypeEnum;
  tier: ModelTierEnum | null;
  routing: ConfigSpec["routing"];
}

// DEV_NOTE: Server-side only — the exact company key value a model was built with. iv and key version change on every
// replacement, so a late rejection can only invalidate this value, never one the admin put in since.
export type UsedModelKey = Pick<CompanySecret, "publicId" | "iv" | "encryptionKeyVersion">;

// DEV_NOTE: Server-side only — one routed model: what its calls are recorded against
export interface ModelCallContext {
  request: GetModelRequest;
  tier: ModelTierEnum;
  provider: ModelProviderEnum;
  model: string;
  price: ModelPrice;
  usedKey: UsedModelKey;
}

// DEV_NOTE: Server-side only — one finished call, as the recording middleware saw it. usage is null when the call
// ended without the provider's usage; usageStatus says what the row's tokens mean (ModelCallUsageStatusIntEnum).
export interface ModelCallRecord {
  usage: ModelCallUsage | null;
  usageStatus: ModelCallUsageStatusIntEnum;
  gatewayLogId: string | null;
  latencyMs: number;
  errorCode: string | null;
}

// DEV_NOTE: Server-side only — the key-failure path (ModelKeyFailureProvider). usedKey null = there was no active key.
export interface ModelKeyFailureRequest {
  companyId: string;
  conversationId: string | null;
  provider: ModelProviderEnum;
  usedKey: UsedModelKey | null;
  reason: ModelKeyFailureReasonEnum;
}
