import type { ActivityLog } from "./ActivityLogCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints)
export interface ActivityLogDALResponse extends ApiResponse {
  activityLog?: ActivityLog;
}
