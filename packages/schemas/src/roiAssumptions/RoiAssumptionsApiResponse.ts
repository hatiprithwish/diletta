import type { ApiResponse } from "../common";
import type { RoiAssumptionView } from "./RoiAssumptionsCommon";

export interface CreateRoiAssumptionApiResponse extends ApiResponse {
  roiAssumption?: RoiAssumptionView;
}
