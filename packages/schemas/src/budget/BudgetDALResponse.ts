import type { ApiResponse } from "../common";

// DAL results are server-side only. totalCostUsd is the numeric sum as pg returns it ("0.000000" when no rows).
export interface ModelCallCostSumDALResponse extends ApiResponse {
  totalCostUsd?: string;
}
