import type { EventOutbox } from "./EventOutboxCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints)
export interface EventOutboxDALResponse extends ApiResponse {
  eventOutbox?: EventOutbox;
}

export interface EventOutboxesDALResponse extends ApiResponse {
  eventOutboxes?: EventOutbox[];
}

export interface DeletedEventOutboxesDALResponse extends ApiResponse {
  deletedCount?: number;
}
