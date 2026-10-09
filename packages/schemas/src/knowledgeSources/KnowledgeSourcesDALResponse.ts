import type { KnowledgeSource } from "./KnowledgeSourcesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface KnowledgeSourceDALResponse extends ApiResponse {
  knowledgeSource?: KnowledgeSource;
}

export interface KnowledgeSourcesDALResponse extends ApiResponse {
  knowledgeSources?: KnowledgeSource[];
}
