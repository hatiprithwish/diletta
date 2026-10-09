// DEV_NOTE: The one embedding model for knowledge (Workers AI, platform-paid, halfvec(1024)). Every chunk stores the
// model it was embedded with, and a search never mixes models: changing it means re-embedding every chunk.
export const KNOWLEDGE_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1024;

// DEV_NOTE: One searchable piece of a document, as the chunker cuts it. headingPath ("Billing > Refunds") is the
// headings above it, prepended to the text before embedding and weighted above the body in the keyword index.
export interface KnowledgeChunkDraft {
  chunkIndex: number;
  headingPath: string | null;
  text: string;
}

// DEV_NOTE: A chunk ready to store: its draft plus the vector and the model that made it
export interface EmbeddedKnowledgeChunk extends KnowledgeChunkDraft {
  embedding: number[];
  embeddingModel: string;
}
