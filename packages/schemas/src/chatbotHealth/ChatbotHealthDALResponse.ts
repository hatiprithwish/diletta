import type { ApiResponse } from "../common";
import type { ActivityRollupDay } from "../activityRollups/ActivityRollupsCommon";

export interface ChatbotHealthRollupRow {
  chatbotId: string;
  day: ActivityRollupDay;
  metric: string;
  value: string;
}

export interface ChatbotHealthRollupsDALResponse extends ApiResponse {
  rows?: ChatbotHealthRollupRow[];
}

export interface ChatbotHealthDayDALResponse extends ApiResponse {
  hasDay?: boolean;
}
