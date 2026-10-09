import type { ModelCall } from "./ModelCallsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). Server-side only.
export interface ModelCallDALResponse extends ApiResponse {
  modelCall?: ModelCall;
}

export interface ModelCallsDALResponse extends ApiResponse {
  modelCalls?: ModelCall[];
}

// DEV_NOTE: totalCostUsd is the numeric sum as pg returns it ("0.000000" when no rows)
export interface ModelCallCostSumDALResponse extends ApiResponse {
  totalCostUsd?: string;
}
