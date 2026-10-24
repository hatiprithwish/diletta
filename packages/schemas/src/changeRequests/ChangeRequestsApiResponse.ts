import type { ApiResponse } from "../common";
import type {
  ChangeRequestErrorCodeEnum,
  ChangeRequestListTabEnum,
  ChangeRequestResolveFailureEnum,
  ChangeRequestStatusIntEnum,
  ChangeRequestStatusLabelEnum,
  ChangeRequestTimelineToneEnum,
} from "./ChangeRequestsCommon";

// DEV_NOTE: One row of the Changes list (M4-5). Never the change's values. requesterName null = the host sent no name
// (or the user was erased); toolName null = the tool definition is gone. errorLabel says why it failed or needs a
// person.
export interface ChangeRequestListItem {
  publicId: string;
  summary: string;
  changeCount: number;
  changeRequestStatus: ChangeRequestStatusIntEnum;
  changeRequestStatusLabel: ChangeRequestStatusLabelEnum;
  errorCode: ChangeRequestErrorCodeEnum | null;
  errorLabel: string | null;
  toolName: string | null;
  toolVersion: number;
  requesterName: string | null;
  createdAt: string;
  updatedAt: string;
}

// DEV_NOTE: The count behind each tab, keyed by the tab itself, under the same requester and chatbot filters
export type ChangeRequestTabCounts = Record<ChangeRequestListTabEnum, number>;

// DEV_NOTE: One choice of the Requested by filter: a chatbot user of the company with at least one change request.
// hostUserId is the host's own id for that user (chatbot_users' client id). name null = the host sent none.
export interface ChangeRequestRequester {
  hostUserId: string;
  name: string | null;
}

export interface GetChangeRequestsApiResponse extends ApiResponse {
  changeRequests?: ChangeRequestListItem[];
  totalRecords?: number;
  tabCounts?: ChangeRequestTabCounts;
  requesters?: ChangeRequestRequester[];
}

// DEV_NOTE: One step of a change's timeline, read from its activity_log events, oldest first: what happened in plain
// words (the actor's name in it, never a record's values) and when
export interface ChangeRequestTimelineEntry {
  label: string;
  tone: ChangeRequestTimelineToneEnum;
  createdAt: string;
}

// DEV_NOTE: GET /dashboard/change-requests/:publicId (M4-4, grown by M4-5 with the timeline). Never the change's
// values. errorLabel says why it failed or needs a person. conversation.title null = purged or none.
export interface ChangeRequestDetail {
  publicId: string;
  summary: string;
  changeCount: number;
  changeRequestStatus: ChangeRequestStatusIntEnum;
  changeRequestStatusLabel: ChangeRequestStatusLabelEnum;
  errorCode: ChangeRequestErrorCodeEnum | null;
  errorLabel: string | null;
  toolName: string | null;
  toolVersion: number;
  wasEdited: boolean;
  undoUntil: string | null;
  createdAt: string;
  updatedAt: string;
  conversation: {
    publicId: string;
    title: string | null;
    chatbotName: string | null;
    userName: string | null;
  };
  timeline: ChangeRequestTimelineEntry[];
}

export interface GetChangeRequestApiResponse extends ApiResponse {
  changeRequest?: ChangeRequestDetail;
}

// DEV_NOTE: GET /dashboard/change-requests/needs-human-count: the sidebar's Changes badge (DESIGN.md §4)
export interface GetChangeRequestsNeedsHumanCountApiResponse extends ApiResponse {
  needsHumanCount?: number;
}

// DEV_NOTE: POST /dashboard/change-requests/:publicId/resolve (M4-5): the change as it stands after. failure set (409)
// = it no longer needs a person (resolved already, or never did)
export interface ResolveChangeRequestApiResponse extends ApiResponse {
  changeRequest?: ChangeRequestDetail;
  failure?: ChangeRequestResolveFailureEnum;
}
