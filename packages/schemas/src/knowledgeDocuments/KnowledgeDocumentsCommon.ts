export enum KnowledgeDocumentIndexStatusIntEnum {
  Pending = 1,
  Indexed = 2,
  Failed = 3,
}

export enum KnowledgeDocumentIndexStatusLabelEnum {
  Pending = "Pending",
  Indexed = "Indexed",
  Failed = "Failed",
}

export const KNOWLEDGE_DOCUMENT_INDEX_STATUS_LABEL_MAP: Record<
  KnowledgeDocumentIndexStatusIntEnum,
  KnowledgeDocumentIndexStatusLabelEnum
> = {
  [KnowledgeDocumentIndexStatusIntEnum.Pending]: KnowledgeDocumentIndexStatusLabelEnum.Pending,
  [KnowledgeDocumentIndexStatusIntEnum.Indexed]: KnowledgeDocumentIndexStatusLabelEnum.Indexed,
  [KnowledgeDocumentIndexStatusIntEnum.Failed]: KnowledgeDocumentIndexStatusLabelEnum.Failed,
};
