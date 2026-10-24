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

// DEV_NOTE: A change request as the dashboard shows it (M4-4): never its values (encrypted_changes is not read), with
// its tool and the conversation it came from. toolName null = the definition is gone; userName null = no name sent.
export interface DashboardChangeRequestRow {
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
