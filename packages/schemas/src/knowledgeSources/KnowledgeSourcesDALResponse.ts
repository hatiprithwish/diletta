import type { KnowledgeSource } from "./KnowledgeSourcesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface KnowledgeSourceDALResponse extends ApiResponse {
  knowledgeSource?: KnowledgeSource;
}

export interface KnowledgeSourcesDALResponse extends ApiResponse {
  knowledgeSources?: KnowledgeSource[];
}

export interface KnowledgeSourceIdsDALResponse extends ApiResponse {
  knowledgeSourceIds?: string[];
}

// DEV_NOTE: lastFailedAt = the newest sync_heartbeat_at of a failed source (set when its sync failed, never by an
// admin's edit); null when none failed
export interface FailedKnowledgeSourcesSummaryDALResponse extends ApiResponse {
  failedCount?: number;
  lastFailedAt?: Date | null;
}
