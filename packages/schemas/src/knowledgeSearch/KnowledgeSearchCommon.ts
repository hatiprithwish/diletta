import { z } from "zod";
import type { ModelTaskTypeEnum } from "../modelCalls";
import type { KnowledgeModelCall } from "../knowledgeIngestion";
import type { ModelPrice } from "../modelRouter";

// DEV_NOTE: The reranker for knowledge search (Workers AI, platform-paid, tier Embed like the embeddings). Per query,
// never stored. Its input is capped at 512 tokens per (query, chunk) pair, which a ~400-token chunk fits.
export const KNOWLEDGE_RERANK_MODEL = "@cf/baai/bge-reranker-base";

// DEV_NOTE: The one tool the Conversation DO offers (M2-6): the model searches the bot's knowledge with a query it
// writes. Offered only when the bot's config lists at least one source.
export const SEARCH_HELP_DOCS_TOOL_NAME = "search_help_docs";
export const KNOWLEDGE_SEARCH_QUERY_MAX_CHARS = 500;

export const ZSearchHelpDocsInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(KNOWLEDGE_SEARCH_QUERY_MAX_CHARS)
    .describe("What to look up in the help docs, as a short search query"),
});
export type SearchHelpDocsInput = z.infer<typeof ZSearchHelpDocsInput>;

// DEV_NOTE: How a search ended. NoResults covers both an empty search and one where nothing scored above
// KNOWLEDGE_SEARCH_MIN_SCORE (the model then says it doesn't know); Unavailable is a failed search (logged).
export enum SearchHelpDocsStatusEnum {
  Found = "found",
  NoResults = "no_results",
  Unavailable = "unavailable",
}

// DEV_NOTE: One source a search found or a reply cites, as the tool's output, messages.content and the widget carry
// it. n is the [n] marker in the reply text, numbered across the turn's searches. Client-facing: the document's
// publicId, never an internal id, and never the excerpt text.
export const ZKnowledgeCitation = z.object({
  n: z.number().int().min(1),
  documentPublicId: z.string().min(1),
  title: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});
export type KnowledgeCitation = z.infer<typeof ZKnowledgeCitation>;

// DEV_NOTE: The tool's output: how the search ended and the citations of its results. Stored in the Think transcript
// and streamed to the widget (its search step and Sources list), so it never carries excerpt text: that stays in the
// Conversation DO's memory for the turn (SearchHelpDocsExcerpt) and reaches only the model.
export const ZSearchHelpDocsOutput = z.object({
  status: z.enum(SearchHelpDocsStatusEnum),
  results: z.array(ZKnowledgeCitation),
});
export type SearchHelpDocsOutput = z.infer<typeof ZSearchHelpDocsOutput>;

// DEV_NOTE: Server-side only — one result as the model reads it inside the untrusted fence: its citation plus the
// chunk. Held in the running turn's memory by tool call id (ActiveTurn.searchExcerpts), never stored or streamed.
export interface SearchHelpDocsExcerpt extends KnowledgeCitation {
  headingPath: string | null;
  text: string;
}

// DEV_NOTE: Server-side only — a chunk one side of the hybrid search matched (KnowledgeChunksDAL), with its document's
// citation fields. chunkId is internal: it dedupes the two sides and never leaves the Repo.
export interface KnowledgeChunkMatch {
  chunkId: string;
  documentPublicId: string;
  title: string | null;
  sourceUrl: string | null;
  headingPath: string | null;
  text: string;
}

// DEV_NOTE: Server-side only — a match after reciprocal rank fusion of the vector and keyword lists
export interface FusedKnowledgeChunk extends KnowledgeChunkMatch {
  fusedScore: number;
}

// DEV_NOTE: Server-side only — a search hit: a fused match with its rerank score in [0, 1], best first
export interface KnowledgeSearchHit extends KnowledgeChunkMatch {
  score: number;
}

// DEV_NOTE: Server-side only — the Workers AI calls one search step made, for their model_calls rows. price is the
// model's, checked before the search made any call.
export interface KnowledgeSearchModelCalls {
  taskType: ModelTaskTypeEnum.SearchEmbed | ModelTaskTypeEnum.SearchRerank;
  model: string;
  price: ModelPrice;
  calls: KnowledgeModelCall[];
}

// DEV_NOTE: Server-side only — the platform prices of the search's two models, looked up once before any call, so an
// unpriced model is refused up front and every row is priced from the same lookup
export interface KnowledgeSearchPrices {
  embed: ModelPrice;
  rerank: ModelPrice;
}
