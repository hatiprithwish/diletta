import type {
  KnowledgeEmbedCall,
  KnowledgeSyncItem,
  KnowledgeSyncItemOutcomeEnum,
  ParsedSitemap,
} from "./KnowledgeIngestionCommon";
import type { EmbeddedKnowledgeChunk } from "../knowledgeChunks";
import type { KnowledgeDocument } from "../knowledgeDocuments";
import type { KnowledgeSource, KnowledgeSourceStateResponse } from "../knowledgeSources";
import type { ApiResponse } from "../common";

// DEV_NOTE: The sync's item list. isStopped: the source is gone or no longer Syncing, so nothing runs.
// isWebSource: the listing is the whole site, so documents missing from it are pruned after the sync.
export interface ListKnowledgeSyncItemsResponse extends ApiResponse {
  items?: KnowledgeSyncItem[];
  isStopped?: boolean;
  isWebSource?: boolean;
}

export interface IngestKnowledgeSyncItemResponse extends ApiResponse {
  outcome?: KnowledgeSyncItemOutcomeEnum;
  embedCallCount?: number;
}

export interface PruneKnowledgeDocumentsResponse extends ApiResponse {
  deletedCount?: number;
}

// DEV_NOTE: The re-sync Cron's run: how many due sources it started
export interface StartDueKnowledgeSyncsResponse extends ApiResponse {
  startedCount?: number;
  failedCount?: number;
}

// DEV_NOTE: A fetched page or sitemap (KnowledgeFetchProvider). mime is the response's type without parameters;
// finalUrl is where redirects ended.
export interface KnowledgeFetchResponse extends ApiResponse {
  bytes?: Uint8Array<ArrayBuffer>;
  mime?: string;
  finalUrl?: string;
}

export interface SitemapUrlsResponse extends ApiResponse {
  urls?: string[];
}

// DEV_NOTE: A document's text as markdown (KnowledgeExtractProvider)
export interface KnowledgeTextResponse extends ApiResponse {
  text?: string;
}

// DEV_NOTE: Vectors in input order (KnowledgeEmbedProvider). calls lists every Workers AI call made, failed ones too,
// so each gets its model_calls row even when the embedding as a whole failed.
export interface KnowledgeEmbedResponse extends ApiResponse {
  embeddings?: number[][];
  calls?: KnowledgeEmbedCall[];
}

// DEV_NOTE: An object read back from R2 (FileStorageProvider)
export interface FileObjectResponse extends ApiResponse {
  bytes?: Uint8Array<ArrayBuffer>;
}

export interface ParsedSitemapResponse extends ApiResponse {
  parsed?: ParsedSitemap;
}

// DEV_NOTE: KnowledgeDocumentFilesProvider.create: the new document, and the R2 key it wrote, which the Repo deletes
// when its transaction then rolls back (set even on failure once the object was written)
export interface CreateKnowledgeDocumentWithFileResponse extends ApiResponse {
  knowledgeDocument?: KnowledgeDocument;
  fileR2Key?: string;
}

// DEV_NOTE: KnowledgeDocumentFilesProvider.remove: the R2 keys of the deleted files, deleted after the commit
export interface RemoveKnowledgeDocumentsResponse extends ApiResponse {
  deletedCount?: number;
  fileR2Keys?: string[];
}

// DEV_NOTE: KnowledgeIngestionRepo internals (server-side only). The source is set only while it is Syncing.
export interface SyncingKnowledgeSourceResponse extends ApiResponse {
  source?: KnowledgeSource;
  companyPublicId?: string;
}

// DEV_NOTE: What one sync item needs: isStopped when the source is gone or no longer Syncing; existing is the document
// the item already has (null for a page not seen before)
export interface KnowledgeSyncItemContextResponse extends SyncingKnowledgeSourceResponse {
  isStopped?: boolean;
  existing?: KnowledgeDocument | null;
}

// DEV_NOTE: Embedded chunks in input order; callCount = Workers AI calls made (each has its model_calls row)
export interface EmbedKnowledgeChunksResponse extends ApiResponse {
  chunks?: EmbeddedKnowledgeChunk[];
  callCount: number;
}

// DEV_NOTE: KnowledgeSourcesRepo internals (server-side only): the claimed source row (internal ids) for the sync it
// starts, and the R2 keys a delete leaves to remove after its commit
export interface ClaimKnowledgeSyncResponse extends KnowledgeSourceStateResponse {
  source?: KnowledgeSource;
}

export interface KnowledgeRemovalResponse extends KnowledgeSourceStateResponse {
  fileR2Keys?: string[];
}
