import type { KnowledgeChunkMatch, KnowledgeSearchHit } from "./KnowledgeSearchCommon";
import type { KnowledgeModelCall } from "../knowledgeIngestion";
import type { ApiResponse } from "../common";

// DEV_NOTE: Server-side only — the hits that scored at least KNOWLEDGE_SEARCH_MIN_SCORE, best first, at most topK.
// An empty list is a success (nothing relevant, or the bot has no source left in the company).
export interface SearchKnowledgeResponse extends ApiResponse {
  hits?: KnowledgeSearchHit[];
}

// DEV_NOTE: Server-side only — KnowledgeRerankProvider: one score in [0, 1] per input text, in input order, and the
// call made (failed too) for its model_calls row
export interface KnowledgeRerankResponse extends ApiResponse {
  scores?: number[];
  call?: KnowledgeModelCall;
}

// DEV_NOTE: Server-side only — KnowledgeSearchRepo internals: what a search may look in (the company's public id for
// the gateway metadata, and the internal ids of the bot's sources that exist in the company), then what each side of
// the hybrid search matched
export interface KnowledgeSearchScopeResponse extends ApiResponse {
  companyPublicId?: string;
  knowledgeSourceIds?: string[];
}

export interface KnowledgeSearchCandidatesResponse extends ApiResponse {
  vectorMatches?: KnowledgeChunkMatch[];
  keywordMatches?: KnowledgeChunkMatch[];
}
