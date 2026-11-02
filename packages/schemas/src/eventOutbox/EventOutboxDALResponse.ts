import type { EventOutbox } from "./EventOutboxCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints)
export interface EventOutboxDALResponse extends ApiResponse {
  eventOutbox?: EventOutbox;
}

export interface EventOutboxesDALResponse extends ApiResponse {
  eventOutboxes?: EventOutbox[];
}

// DEV_NOTE: oldestPendingCreatedAt null = nothing pending. failedCount = rows in Failed, which only the relay-failure
// runbook clears.
export interface EventOutboxHealthDALResponse extends ApiResponse {
  health?: {
    oldestPendingCreatedAt: Date | null;
    pendingCount: number;
    failedCount: number;
  };
}

export interface DeletedEventOutboxesDALResponse extends ApiResponse {
  deletedCount?: number;
}
