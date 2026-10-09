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

// DEV_NOTE: The sync's own state changes (claim → Syncing with a new syncRunId, finish → Active / Failed). A null
// lastSyncedAt / syncRunId is left as it is. sync_heartbeat_at and updatedAt are set by the DAL. updatedBy is not
// touched: the sync is the system.
export type SetKnowledgeSourceSyncStateDALRequest = Pick<
  KnowledgeSource,
  "publicId" | "companyId" | "status"
> &
  NullableDALFields<Pick<KnowledgeSource, "lastSyncedAt" | "syncRunId">>;

// DEV_NOTE: A live sync's heartbeat (sync_heartbeat_at = now), from every step that holds the source lock
export type TouchKnowledgeSourceSyncDALRequest = Pick<KnowledgeSource, "publicId" | "companyId">;

export type DeleteKnowledgeSourceDALRequest = Pick<KnowledgeSource, "publicId" | "companyId">;

// DEV_NOTE: Platform (withPlatform) — the re-sync Cron across companies. Active web sources whose frequency is due
// (Daily synced before dailyBefore, Weekly before weeklyBefore, or never synced), Daily / Weekly sources left Failed
// whose last attempt (heartbeat) is before failedBefore (a backoff), and sources stuck in Syncing whose heartbeat is
// before staleBefore (the sync died). Oldest first, at most limit. companyIds limits it to some companies (tests on
// the shared staging branch); the Cron passes null.
export type GetDueKnowledgeSourcesDALRequest = {
  dailyBefore: Date;
  weeklyBefore: Date;
  failedBefore: Date;
  staleBefore: Date;
  companyIds: string[] | null;
  limit: number;
};
