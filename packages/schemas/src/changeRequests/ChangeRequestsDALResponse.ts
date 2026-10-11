import type { ApiResponse } from "../common";
import type { ChangeRequest, ChangeRequestRow } from "./ChangeRequestsCommon";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to what the widget sees.
export interface ChangeRequestDALResponse extends ApiResponse {
  changeRequest?: ChangeRequestRow;
}

export interface ChangeRequestsDALResponse extends ApiResponse {
  changeRequests?: ChangeRequestRow[];
}

// DEV_NOTE: The row a status change wrote (without the tool fields: the Repo read those when it locked the row)
export interface ChangeRequestUpdateDALResponse extends ApiResponse {
  changeRequest?: ChangeRequest;
}
