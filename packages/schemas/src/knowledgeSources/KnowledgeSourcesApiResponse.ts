import type {
  KnowledgeSourceFailureEnum,
  KnowledgeSourceWithStatus,
} from "./KnowledgeSourcesCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";

// DEV_NOTE: failure is set (with isSuccess false) when the source's state refused the request; the route answers 409
export interface KnowledgeSourceStateResponse extends ApiResponse {
  failure?: KnowledgeSourceFailureEnum;
}

export interface CreateKnowledgeSourceApiResponse extends ApiResponse {
  knowledgeSource?: KnowledgeSourceWithStatus;
}

export interface GetKnowledgeSourceApiResponse extends ApiResponse {
  knowledgeSource?: KnowledgeSourceWithStatus;
}

export interface GetKnowledgeSourcesApiResponse extends ApiResponse {
  knowledgeSources?: KnowledgeSourceWithStatus[];
}

export type GetKnowledgeSourcesCountApiResponse = TotalRecordsResponse;

export interface UpdateKnowledgeSourceApiResponse extends KnowledgeSourceStateResponse {
  knowledgeSource?: KnowledgeSourceWithStatus;
}

export interface SyncKnowledgeSourceApiResponse extends KnowledgeSourceStateResponse {
  knowledgeSource?: KnowledgeSourceWithStatus;
}
