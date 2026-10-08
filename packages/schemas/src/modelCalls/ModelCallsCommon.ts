import z from "zod";
import { ModelProviderEnum } from "../companySecrets";

export enum ModelCallTierIntEnum {
  Small = 1,
  Mid = 2,
  Top = 3,
  Embed = 4,
}

export enum ModelCallTierLabelEnum {
  Small = "Small",
  Mid = "Mid",
  Top = "Top",
  Embed = "Embed",
}

export const MODEL_CALL_TIER_LABEL_MAP: Record<ModelCallTierIntEnum, ModelCallTierLabelEnum> = {
  [ModelCallTierIntEnum.Small]: ModelCallTierLabelEnum.Small,
  [ModelCallTierIntEnum.Mid]: ModelCallTierLabelEnum.Mid,
  [ModelCallTierIntEnum.Top]: ModelCallTierLabelEnum.Top,
  [ModelCallTierIntEnum.Embed]: ModelCallTierLabelEnum.Embed,
};

// DEV_NOTE: What a model call is for (model_calls.task_type, text in the DB). Embeddings (knowledge.embed) run on
// Workers AI, not through the router; M2-5 adds them here with their provider.
export enum ModelTaskTypeEnum {
  RouteIntent = "route.intent",
  QaAnswer = "qa.answer",
  EvalJudge = "eval.judge",
}

// DEV_NOTE: Where the row's tokens and cost came from.
//   Reported: the provider's own usage (the stream's finish part or the generate result), or a call the provider
//     answered with an error status, which it doesn't bill.
//   Pending: the call reached the provider but ended without usage (stream cut or cancelled, connection lost). The
//     per-minute Cron fills it from the AI Gateway log (gateway_log_id).
//   Backfilled: filled from the gateway log. Its tokens_in has no cache split, so it's priced at the full input price.
//   Unknown: no usage could be found (no log id, or none in the log within the backfill window). Cost stays 0 and an
//     error is logged; the budget must not read 0 as free.
export enum ModelCallUsageStatusIntEnum {
  Reported = 1,
  Pending = 2,
  Backfilled = 3,
  Unknown = 4,
}

export enum ModelCallUsageStatusLabelEnum {
  Reported = "Reported",
  Pending = "Pending",
  Backfilled = "Backfilled",
  Unknown = "Unknown",
}

export const MODEL_CALL_USAGE_STATUS_LABEL_MAP: Record<
  ModelCallUsageStatusIntEnum,
  ModelCallUsageStatusLabelEnum
> = {
  [ModelCallUsageStatusIntEnum.Reported]: ModelCallUsageStatusLabelEnum.Reported,
  [ModelCallUsageStatusIntEnum.Pending]: ModelCallUsageStatusLabelEnum.Pending,
  [ModelCallUsageStatusIntEnum.Backfilled]: ModelCallUsageStatusLabelEnum.Backfilled,
  [ModelCallUsageStatusIntEnum.Unknown]: ModelCallUsageStatusLabelEnum.Unknown,
};

// Whole Model Call Body — DB shape (enums stored as integers)
// DEV_NOTE: One row per model call, written by the model router after the call. Every id but publicId is internal
// (companyId, chatbotId, chatbotUserId, conversationId, evalRunId) — used by DAL/Repo only, NEVER sent to a client.
// costUsd is numeric(12,6), which pg reads as a string so no precision is lost. provider and taskType are text columns
// typed with $type in tables.ts, so they read back as their enums.
export const ZModelCall = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string().nullable(),
  chatbotUserId: z.string().nullable(),
  conversationId: z.string().nullable(),
  evalRunId: z.string().nullable(),
  turnId: z.string().nullable(),
  taskType: z.enum(ModelTaskTypeEnum),
  tier: z.enum(ModelCallTierIntEnum),
  provider: z.enum(ModelProviderEnum),
  model: z.string(),
  gatewayLogId: z.string().nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0).nullable(),
  cachedTokens: z.number().int().min(0),
  costUsd: z.string(),
  latencyMs: z.number().int().min(0).nullable(),
  wasEscalated: z.boolean(),
  errorCode: z.string().nullable(),
  usageStatus: z.enum(ModelCallUsageStatusIntEnum),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ModelCall = z.infer<typeof ZModelCall>;
