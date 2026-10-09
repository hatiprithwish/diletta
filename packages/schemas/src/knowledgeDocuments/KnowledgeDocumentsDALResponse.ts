import type { KnowledgeDocument } from "./KnowledgeDocumentsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface KnowledgeDocumentDALResponse extends ApiResponse {
  knowledgeDocument?: KnowledgeDocument;
}

export interface KnowledgeDocumentsDALResponse extends ApiResponse {
  knowledgeDocuments?: KnowledgeDocument[];
}
