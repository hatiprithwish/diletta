import type { KnowledgeChunkDraft } from "../knowledgeChunks";

// DEV_NOTE: Knowledge ingestion (M2-5): one KnowledgeSyncWorkflow instance per source sync. Params and step results
// are persisted by Workflows, so they carry ids and small values only, never page bytes or text. companyId is the
// internal companies.id (server-side only: workflow params never reach a client).
export interface KnowledgeSyncWorkflowParams {
  companyId: string;
  knowledgeSourcePublicId: string;
}

// DEV_NOTE: What one sync step works on: a web page by URL (sitemap, url sources) or an uploaded document by its
// publicId (upload sources, bytes already in R2)
export type KnowledgeSyncItem = { url: string } | { knowledgeDocumentPublicId: string };

// DEV_NOTE: How one item ended.
//   Indexed: new or changed text, chunked, embedded and stored.
//   Unchanged: content_hash matched the stored document: no chunking and zero embed calls.
//   Failed: fetch, conversion or embedding failed; the document (if any) is marked Failed, the sync goes on.
//   Stopped: the source is no longer syncing (paused or deleted), so the sync ends here.
export enum KnowledgeSyncItemOutcomeEnum {
  Indexed = "Indexed",
  Unchanged = "Unchanged",
  Failed = "Failed",
  Stopped = "Stopped",
}

// DEV_NOTE: A sitemap file as KnowledgeFetchProvider.parseSitemap reads it: a urlset lists pages, a sitemapindex
// lists more sitemaps. locs are the <loc> values, entity-decoded, in file order.
export interface ParsedSitemap {
  isIndex: boolean;
  locs: string[];
}

// DEV_NOTE: KnowledgeChunkerProvider.chunk output. isTruncated: the document had more chunks than the per-document cap
// and only the first ones were kept.
export interface ChunkedKnowledgeDocument {
  chunks: KnowledgeChunkDraft[];
  isTruncated: boolean;
}

// DEV_NOTE: One Workers AI embedding call, for its model_calls row. inputTokens is the upper bound the row is priced
// at (usage Estimated: Workers AI returns no usage); errorCode is set when the call failed.
export interface KnowledgeEmbedCall {
  inputTokens: number;
  latencyMs: number;
  gatewayLogId: string | null;
  errorCode: string | null;
}
