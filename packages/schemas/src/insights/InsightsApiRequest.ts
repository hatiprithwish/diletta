import { z } from "zod";
import { ImpactRangeEnum, InsightsRangeEnum } from "./InsightsCommon";

// DEV_NOTE: GET /dashboard/insights/overview and /usage. Every field optional: the Repo fills the default range.
// botId = a chatbot's public id (DESIGN.md §6); absent = the whole company.
export const ZGetInsightsApiRequest = z.object({
  range: z.enum(InsightsRangeEnum).optional(),
  botId: z.string().min(1).optional(),
});
export type GetInsightsApiRequest = z.infer<typeof ZGetInsightsApiRequest>;

// GET /dashboard/insights/impact
export const ZGetImpactApiRequest = z.object({
  range: z.enum(ImpactRangeEnum).optional(),
  botId: z.string().min(1).optional(),
});
export type GetImpactApiRequest = z.infer<typeof ZGetImpactApiRequest>;

// DEV_NOTE: The pages' URL search (apps/web validateSearch): the range only, and an unknown value falls back to the
// default instead of failing the page
export const ZInsightsPageSearch = z.object({
  range: z.enum(InsightsRangeEnum).optional().catch(undefined),
});
export type InsightsPageSearch = z.infer<typeof ZInsightsPageSearch>;

export const ZImpactPageSearch = z.object({
  range: z.enum(ImpactRangeEnum).optional().catch(undefined),
});
export type ImpactPageSearch = z.infer<typeof ZImpactPageSearch>;
