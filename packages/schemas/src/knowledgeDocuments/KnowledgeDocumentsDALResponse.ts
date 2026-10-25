import type { KnowledgeDocument } from "./KnowledgeDocumentsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface KnowledgeDocumentDALResponse extends ApiResponse {
  knowledgeDocument?: KnowledgeDocument;
}

export interface KnowledgeDocumentsDALResponse extends ApiResponse {
  knowledgeDocuments?: KnowledgeDocument[];
}

// DEV_NOTE: Documents per source, keyed by the source's internal id (a source with none has no key)
export interface KnowledgeDocumentCountsDALResponse extends ApiResponse {
  documentCounts?: Record<string, number>;
}
