import type { ApiResponse } from "../common";
import type {
  ChangeRequestErrorCodeEnum,
  ChangeRequestStatusIntEnum,
  ChangeRequestStatusLabelEnum,
} from "./ChangeRequestsCommon";

// DEV_NOTE: GET /dashboard/change-requests/:publicId (M4-4, grown by M4-5 with the timeline and resolve). Never the
// change's values. errorLabel says why it failed or needs a person. conversation.title null = purged or none.
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
}

export interface GetChangeRequestApiResponse extends ApiResponse {
  changeRequest?: ChangeRequestDetail;
}
