import type { ModelCall } from "./ModelCallsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). Server-side only.
export interface ModelCallDALResponse extends ApiResponse {
  modelCall?: ModelCall;
}

export interface ModelCallsDALResponse extends ApiResponse {
  modelCalls?: ModelCall[];
}
