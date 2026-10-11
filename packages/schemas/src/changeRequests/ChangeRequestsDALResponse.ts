import type { ApiResponse } from "../common";
import type { ChangeRequest, ChangeRequestRow } from "./ChangeRequestsCommon";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to what the widget sees.
export interface ChangeRequestDALResponse extends ApiResponse {
  changeRequest?: ChangeRequestRow;
}

export interface ChangeRequestsDALResponse extends ApiResponse {
  changeRequests?: ChangeRequestRow[];
}

// DEV_NOTE: The row a create or an update wrote (without the tool fields: the Repo has those from the turn's tool or
// from the row it locked)
export interface ChangeRequestWriteDALResponse extends ApiResponse {
  changeRequest?: ChangeRequest;
}
