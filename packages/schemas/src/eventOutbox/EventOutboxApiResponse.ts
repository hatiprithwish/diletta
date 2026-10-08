import type { ApiResponse } from "../common";

// DEV_NOTE: No ApiRequest file: critical events are recorded by server code (Repos, the action engine), never from a
// client body. Every response below is server-side only (internal ids) — never a route response body.

// DEV_NOTE: wasDuplicate = the company already had an outbox row with this dedupeKey; nothing new was written and
// the ids are the existing rows'. Relay outboxId after commit.
export interface RecordCriticalEventResponse extends ApiResponse {
  activityLogId?: string;
  outboxId?: string;
  wasDuplicate?: boolean;
}

// DEV_NOTE: publishedCount = rows handed to the Queue; failedCount = rows whose send failed (still pending, or Failed
// once they reach the attempt cap)
export interface RelayEventsResponse extends ApiResponse {
  publishedCount?: number;
  failedCount?: number;
}

export interface PurgePublishedEventsResponse extends ApiResponse {
  deletedCount?: number;
}
