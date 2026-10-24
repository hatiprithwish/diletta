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

// DEV_NOTE: One event of an entity's timeline (M4-5) with its actor's name: the admin's (actor Admin) or the chatbot
// user's (actor ChatbotUser, null once erased); null for the system or a name never sent. Internal ids stay server-side.
export type ActivityLogTimelineRow = Pick<
  ActivityLog,
  "id" | "actorType" | "entityAction" | "detail" | "createdAt"
> & {
  actorName: string | null;
};

export interface ActivityLogTimelineDALResponse extends ApiResponse {
  activityLogs?: ActivityLogTimelineRow[];
}
