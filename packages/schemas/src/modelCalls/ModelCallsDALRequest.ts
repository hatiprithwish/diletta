import type { ModelCall } from "./ModelCallsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId; reference ids are checked before the insert.
export type CreateModelCallDALRequest = Omit<
  ModelCall,
  "id" | "publicId" | "createdAt" | "updatedAt"
>;

// DEV_NOTE: Platform (withPlatform) — the backfill sweep across companies. Pending rows created before createdBefore
// (the log has had time to appear), least recently tried first (updated_at), so rows whose log isn't there yet take
// turns with newer ones instead of filling every batch. companyIds limits it to some companies (tests on the shared
// staging branch); the Cron passes null.
export type GetPendingModelCallsDALRequest = {
  companyIds: string[] | null;
  createdBefore: Date;
  limit: number;
};

// DEV_NOTE: Settles one Pending row; the DAL only updates a row that is still Pending, so a sweep that overlaps
// another never settles a row twice. Token and cost fields stay as they are when null (an Unknown row keeps its 0s).
export type SettleModelCallUsageDALRequest = Pick<
  ModelCall,
  "companyId" | "publicId" | "usageStatus"
> & {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
};

// DEV_NOTE: Marks a Pending row as just tried (updated_at = now), so the next sweep starts with rows tried longer ago
export type TouchPendingModelCallDALRequest = Pick<ModelCall, "companyId" | "publicId">;

// DEV_NOTE: BudgetDO's seed (M2-4): the spend already recorded for a company since `from` (its billing period start)
export type GetModelCallCostSumDALRequest = Pick<ModelCall, "companyId"> & { from: Date };
