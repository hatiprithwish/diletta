import type { NullableDALFields, PageDALRequest } from "../common";
import type { KnowledgeSource, KnowledgeSourceSortColumn } from "./KnowledgeSourcesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId.
export type CreateKnowledgeSourceDALRequest = Pick<
  KnowledgeSource,
  "companyId" | "type" | "url" | "syncFrequency" | "createdBy"
>;

// DEV_NOTE: isForUpdate locks the row for the rest of the transaction (SELECT … FOR UPDATE), so a state change
// (sync claim, pause, finish, delete) reads and writes the status with no other change in between
export type FindKnowledgeSourceDALRequest = Pick<KnowledgeSource, "publicId" | "companyId"> & {
  isForUpdate: boolean;
};

export type GetKnowledgeSourcesCountDALRequest = Pick<KnowledgeSource, "companyId">;

export type GetKnowledgeSourcesDALRequest = GetKnowledgeSourcesCountDALRequest &
  PageDALRequest & { sortColumn: KnowledgeSourceSortColumn };

// DEV_NOTE: Admin-editable fields; a null param is left as it is. updatedAt is set by the DAL.
export type UpdateKnowledgeSourceDALRequest = Pick<KnowledgeSource, "publicId" | "companyId"> &
  NullableDALFields<Pick<KnowledgeSource, "syncFrequency" | "status">> &
  Pick<KnowledgeSource, "updatedBy">;

// DEV_NOTE: The sync's own state changes (claim → Syncing, finish → Active / Failed). lastSyncedAt null is left as it
// is. updatedBy is not touched: the sync is the system.
export type SetKnowledgeSourceSyncStateDALRequest = Pick<
  KnowledgeSource,
  "publicId" | "companyId" | "status"
> &
  NullableDALFields<Pick<KnowledgeSource, "lastSyncedAt">>;

export type DeleteKnowledgeSourceDALRequest = Pick<KnowledgeSource, "publicId" | "companyId">;

// DEV_NOTE: Platform (withPlatform) — the re-sync Cron across companies. Active web sources whose frequency is due
// (Daily synced before dailyBefore, Weekly before weeklyBefore, or never synced), plus sources stuck in Syncing since
// before staleBefore (the sync died without finishing). Oldest first, at most limit.
export type GetDueKnowledgeSourcesDALRequest = {
  dailyBefore: Date;
  weeklyBefore: Date;
  staleBefore: Date;
  limit: number;
};
