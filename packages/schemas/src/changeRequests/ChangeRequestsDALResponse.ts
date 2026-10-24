import type { ApiResponse, TotalRecordsResponse } from "../common";
import type { ChangeRequestTabCounts } from "./ChangeRequestsApiResponse";
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

// DEV_NOTE: A change request as the dashboard shows it (M4-4): never its values (encrypted_changes is not read), with
// its tool and the conversation it came from. toolName null = the definition is gone; userName null = no name sent
// (or the user was erased). id, conversationId and conversationRootLogId are internal (the timeline and Mark resolved,
// M4-5): the Repo drops them.
export interface DashboardChangeRequestRow {
  id: string;
  conversationId: string;
  conversationRootLogId: string | null;
  publicId: string;
  summary: string;
  changeCount: number;
  status: ChangeRequest["status"];
  // DEV_NOTE: text in the DB, read through Schemas.changeRequestErrorOf
  errorCode: string | null;
  wasEdited: boolean;
  undoUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  toolName: string | null;
  toolVersion: number;
  conversationPublicId: string;
  conversationTitle: string | null;
  conversationContentPurgedAt: Date | null;
  chatbotName: string | null;
  userName: string | null;
}

export interface DashboardChangeRequestDALResponse extends ApiResponse {
  changeRequest?: DashboardChangeRequestRow;
}

export interface DashboardChangeRequestsDALResponse extends ApiResponse {
  changeRequests?: DashboardChangeRequestRow[];
}

// DEV_NOTE: Every tab's count; totalRecords = All's
export interface ChangeRequestTabCountsDALResponse extends TotalRecordsResponse {
  tabCounts?: ChangeRequestTabCounts;
}

// DEV_NOTE: A requester with its internal id (the Repo matches the filter's host user id to it, then drops it)
export interface ChangeRequestRequesterRow {
  chatbotUserId: string;
  hostUserId: string;
  name: string | null;
}

export interface ChangeRequestRequestersDALResponse extends ApiResponse {
  requesters?: ChangeRequestRequesterRow[];
}
