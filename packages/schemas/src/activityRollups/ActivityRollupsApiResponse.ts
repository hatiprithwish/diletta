import type { ApiResponse } from "../common";
import type { ActivityRollupDay } from "./ActivityRollupsCommon";

// DEV_NOTE: Every day is rebuilt on its own transaction, so one failed day leaves the others rebuilt
export interface RebuildActivityRollupsApiResponse extends ApiResponse {
  rebuiltDays?: ActivityRollupDay[];
  failedDays?: ActivityRollupDay[];
}

export interface RebuildActivityRollupDayResponse extends ApiResponse {
  rowCount?: number;
}

// The hourly run across companies: counts of (company, day) rebuilds
export interface RebuildRecentActivityRollupsResponse extends ApiResponse {
  rebuiltCount: number;
  failedCount: number;
}
