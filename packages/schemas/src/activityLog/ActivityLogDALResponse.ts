import type { ActivityLog } from "./ActivityLogCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints)
export interface ActivityLogDALResponse extends ApiResponse {
  activityLog?: ActivityLog;
}

export interface ActivityLogsDALResponse extends ApiResponse {
  activityLogs?: ActivityLog[];
}

// DEV_NOTE: wasCreated = false when the month's partition already existed
export interface ActivityLogPartitionDALResponse extends ApiResponse {
  partitionName?: string;
  wasCreated?: boolean;
}

export interface ActivityLogDefaultPartitionDALResponse extends ApiResponse {
  hasRows?: boolean;
}
