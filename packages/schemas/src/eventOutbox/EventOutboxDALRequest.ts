import type { EventOutbox } from "./EventOutboxCommon";

// DEV_NOTE: Tenant requests carry companyId — every query filters on it, on top of RLS. companyId is null only for
// the cross-company relay sweep, which runs under withPlatform.
export type CreateEventOutboxDALRequest = Pick<
  EventOutbox,
  "companyId" | "activityLogId" | "eventType" | "dedupeKey"
>;

export type FindEventOutboxByDedupeKeyDALRequest = Pick<EventOutbox, "companyId" | "dedupeKey">;

// DEV_NOTE: Pending rows to publish, locked FOR UPDATE SKIP LOCKED so a concurrent relay or sweep skips them.
// After-commit relay: companyId + outboxIds. Sweep: companyId null, rows created before createdBefore.
export type LockPendingEventOutboxesDALRequest = {
  companyId: string | null;
  outboxIds: string[] | null;
  createdBefore: Date | null;
  limit: number;
};

export type MarkEventOutboxesPublishedDALRequest = {
  companyId: string | null;
  outboxIds: string[];
};

// DEV_NOTE: attempts + 1 and lastError on every row; rows reaching maxAttempts move to Failed
export type MarkEventOutboxAttemptFailedDALRequest = {
  companyId: string | null;
  outboxIds: string[];
  lastError: string;
  maxAttempts: number;
};

// DEV_NOTE: Cross-company purge (withPlatform): published rows older than publishedBefore
export type DeletePublishedEventOutboxesDALRequest = {
  publishedBefore: Date;
};
