import type { ApiResponse } from "../common";
import type { RoiAssumption } from "./RoiAssumptionsCommon";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface RoiAssumptionDALResponse extends ApiResponse {
  roiAssumption?: RoiAssumption;
}

export interface RoiAssumptionsDALResponse extends ApiResponse {
  roiAssumptions?: RoiAssumption[];
}
