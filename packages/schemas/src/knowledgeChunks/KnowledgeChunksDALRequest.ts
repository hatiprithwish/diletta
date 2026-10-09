import type { EmbeddedKnowledgeChunk } from "./KnowledgeChunksCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. knowledge_chunks
// is derived (no publicId, no updated_at): a document's chunks are deleted and written again whenever it changes.
// knowledgeSourceId is copied from the document for the search filter.
export type CreateKnowledgeChunksDALRequest = {
  companyId: string;
  knowledgeDocumentId: string;
  knowledgeSourceId: string;
  chunks: EmbeddedKnowledgeChunk[];
};

export type DeleteKnowledgeChunksByDocumentsDALRequest = {
  companyId: string;
  knowledgeDocumentIds: string[];
};

// DEV_NOTE: The two sides of the hybrid search (M2-6). Both match only the given sources' chunks of Indexed documents
// that were embedded with embeddingModel (models are never mixed), and return at most limit matches, best first.
// efSearch is the HNSW candidate list size for the vector side (≥ limit).
export type SearchKnowledgeChunksByVectorDALRequest = {
  companyId: string;
  knowledgeSourceIds: string[];
  embeddingModel: string;
  embedding: number[];
  limit: number;
  efSearch: number;
};

export type SearchKnowledgeChunksByKeywordDALRequest = {
  companyId: string;
  knowledgeSourceIds: string[];
  embeddingModel: string;
  query: string;
  limit: number;
};

export type DeleteKnowledgeChunksBySourceDALRequest = {
  companyId: string;
  knowledgeSourceId: string;
};
