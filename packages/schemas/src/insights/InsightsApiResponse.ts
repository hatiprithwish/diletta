import type { ApiResponse } from "../common";
import type { InsightsImpact, InsightsOverview, InsightsUsage } from "./InsightsCommon";

export interface GetInsightsOverviewApiResponse extends ApiResponse {
  overview?: InsightsOverview;
}

export interface GetInsightsUsageApiResponse extends ApiResponse {
  usage?: InsightsUsage;
}

export interface GetInsightsImpactApiResponse extends ApiResponse {
  impact?: InsightsImpact;
}
