import type { EventOutbox } from "./EventOutboxCommon";

// DEV_NOTE: Tenant requests carry companyId — every query filters on it, on top of RLS. companyId is null only for
// the cross-company relay sweep, which runs under withPlatform.
export type CreateEventOutboxDALRequest = Pick<
  EventOutbox,
  "companyId" | "activityLogId" | "eventType" | "dedupeKey"
>;

export type FindEventOutboxByDedupeKeyDALRequest = Pick<EventOutbox, "companyId" | "dedupeKey">;

// DEV_NOTE: Serializes writers of the same (companyId, dedupeKey) until the transaction ends
export type LockEventOutboxDedupeKeyDALRequest = FindEventOutboxByDedupeKeyDALRequest;

// DEV_NOTE: Pending rows to publish, locked FOR UPDATE SKIP LOCKED so a concurrent relay or sweep skips them.
// After-commit relay: companyId + outboxIds. Sweep: companyId null, rows created before createdBefore, optionally
// limited to companyIds (tests scope the cross-company sweep to their own companies; the Cron passes null).
export type LockPendingEventOutboxesDALRequest = {
  companyId: string | null;
  companyIds: string[] | null;
  outboxIds: string[] | null;
  createdBefore: Date | null;
  limit: number;
};

export type MarkEventOutboxesPublishedDALRequest = {
  companyId: string | null;
  outboxIds: string[];
};

// DEV_NOTE: A send that failed for the whole Queue (an outage): lastError only, no attempt counted
export type SetEventOutboxLastErrorDALRequest = {
  companyId: string | null;
  outboxIds: string[];
  lastError: string;
};

// DEV_NOTE: A send that failed for these rows only: attempts + 1 and lastError; rows reaching maxAttempts move to Failed
export type MarkEventOutboxAttemptFailedDALRequest = {
  companyId: string | null;
  outboxIds: string[];
  lastError: string;
  maxAttempts: number;
};

// DEV_NOTE: Cross-company purge (withPlatform): published rows older than publishedBefore, optionally limited to
// companyIds (tests only; the Cron passes null)
export type DeletePublishedEventOutboxesDALRequest = {
  publishedBefore: Date;
  companyIds: string[] | null;
};
