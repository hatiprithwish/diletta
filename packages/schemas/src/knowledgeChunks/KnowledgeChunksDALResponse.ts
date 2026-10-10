import type { ApiResponse } from "../common";
import type { KnowledgeChunkMatch } from "../knowledgeSearch";

export interface KnowledgeChunksWriteDALResponse extends ApiResponse {
  rowCount?: number;
}

export interface KnowledgeChunkMatchesDALResponse extends ApiResponse {
  matches?: KnowledgeChunkMatch[];
}
