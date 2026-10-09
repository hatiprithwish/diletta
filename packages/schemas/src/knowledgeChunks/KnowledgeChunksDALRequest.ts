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

export type DeleteKnowledgeChunksBySourceDALRequest = {
  companyId: string;
  knowledgeSourceId: string;
};
