import type {
  FusedKnowledgeChunk,
  KnowledgeSearchHit,
  KnowledgeSearchModelCalls,
} from "./KnowledgeSearchCommon";
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

// DEV_NOTE: Server-side only — KnowledgeSearchRepo's steps. Every field past ApiResponse is optional, so a failed
// withTenant (a plain ApiResponse) is assignable to the step's type and callers read the fields without narrowing.
// scope: the company's public id (gateway metadata) and the internal ids of the bot's sources in the company.
export interface KnowledgeSearchScopeResponse extends ApiResponse {
  companyPublicId?: string;
  knowledgeSourceIds?: string[];
}

// DEV_NOTE: The query's embedding, and the call that made it (failed too) for its model_calls row
export interface KnowledgeSearchEmbeddingResponse extends ApiResponse {
  embedding?: number[];
  calls: KnowledgeSearchModelCalls;
}

// DEV_NOTE: The two sides' matches fused by reciprocal rank, best first, at most KNOWLEDGE_SEARCH_RERANK_CANDIDATES
export interface KnowledgeSearchCandidatesResponse extends ApiResponse {
  candidates?: FusedKnowledgeChunk[];
}

// DEV_NOTE: One rerank score per candidate in candidate order, and the call that made them (failed too)
export interface KnowledgeSearchRerankResponse extends ApiResponse {
  scores?: number[];
  calls: KnowledgeSearchModelCalls;
}
