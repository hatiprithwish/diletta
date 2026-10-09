import type { KnowledgeDocumentWithStatus } from "./KnowledgeDocumentsCommon";
import type { KnowledgeSourceStateResponse } from "../knowledgeSources";
import type { ApiResponse, TotalRecordsResponse } from "../common";

export interface UploadKnowledgeDocumentApiResponse extends KnowledgeSourceStateResponse {
  knowledgeDocument?: KnowledgeDocumentWithStatus;
}

export interface GetKnowledgeDocumentsApiResponse extends ApiResponse {
  knowledgeDocuments?: KnowledgeDocumentWithStatus[];
}

export type GetKnowledgeDocumentsCountApiResponse = TotalRecordsResponse;

export type DeleteKnowledgeDocumentApiResponse = KnowledgeSourceStateResponse;
