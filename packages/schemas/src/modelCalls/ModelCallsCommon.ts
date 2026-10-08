import z from "zod";

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

// Whole Model Call Body — DB shape (enums stored as integers)
// DEV_NOTE: One row per model call, written by the model router after the call. Every id but publicId is internal
// (companyId, chatbotId, chatbotUserId, conversationId, evalRunId) — used by DAL/Repo only, NEVER sent to a client.
// costUsd is numeric(12,6), which pg reads as a string so no precision is lost.
export const ZModelCall = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string().nullable(),
  chatbotUserId: z.string().nullable(),
  conversationId: z.string().nullable(),
  evalRunId: z.string().nullable(),
  turnId: z.string().nullable(),
  taskType: z.string(),
  tier: z.enum(ModelCallTierIntEnum),
  provider: z.string(),
  model: z.string(),
  gatewayLogId: z.string().nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0).nullable(),
  cachedTokens: z.number().int().min(0),
  costUsd: z.string(),
  latencyMs: z.number().int().min(0).nullable(),
  wasEscalated: z.boolean(),
  errorCode: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ModelCall = z.infer<typeof ZModelCall>;
