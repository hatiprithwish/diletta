import type { NullableDALFields, PageDALRequest } from "../common";
import type {
  KnowledgeDocument,
  KnowledgeDocumentIndexStatusIntEnum,
  KnowledgeDocumentSortColumn,
} from "./KnowledgeDocumentsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId and checks the source and file exist.
export type CreateKnowledgeDocumentDALRequest = Pick<
  KnowledgeDocument,
  | "companyId"
  | "knowledgeSourceId"
  | "fileId"
  | "title"
  | "sourceUrl"
  | "contentHash"
  | "indexStatus"
  | "lastSyncedAt"
>;

// Params to find a document by its public ID within one source of one company
export type FindKnowledgeDocumentDALRequest = Pick<
  KnowledgeDocument,
  "publicId" | "companyId" | "knowledgeSourceId"
>;

// DEV_NOTE: A web page is one document per source, found by its URL (the sync lists each URL once)
export type FindKnowledgeDocumentBySourceUrlDALRequest = Pick<
  KnowledgeDocument,
  "companyId" | "knowledgeSourceId"
> & { sourceUrl: string };

// DEV_NOTE: The sync's writes; a null param is left as it is. fileId moves to a new file when a page's bytes change.
// updatedAt is set by the DAL.
export type UpdateKnowledgeDocumentDALRequest = Pick<KnowledgeDocument, "id" | "companyId"> &
  NullableDALFields<
    Pick<KnowledgeDocument, "title" | "contentHash" | "indexStatus" | "lastSyncedAt" | "fileId">
  >;

// DEV_NOTE: The documents of one source, by title when search is set (case-insensitive, the text taken literally)
export type SearchKnowledgeDocumentsDALRequest = Pick<
  KnowledgeDocument,
  "companyId" | "knowledgeSourceId"
> & { search: string | null };

export type GetKnowledgeDocumentsDALRequest = SearchKnowledgeDocumentsDALRequest &
  PageDALRequest & { sortColumn: KnowledgeDocumentSortColumn };

// DEV_NOTE: The source-scoped reads and deletes of the sync
export type GetKnowledgeDocumentsCountDALRequest = Pick<
  KnowledgeDocument,
  "companyId" | "knowledgeSourceId"
>;

// DEV_NOTE: How many documents each of these sources holds (the Knowledge page's Sources table, M4-7); a source with
// none is left out of the answer
export type GetKnowledgeDocumentCountsBySourceDALRequest = Pick<KnowledgeDocument, "companyId"> & {
  knowledgeSourceIds: string[];
};

// DEV_NOTE: One document by its public id anywhere in the company (a gap cluster's answer, M4-7)
export type FindCompanyKnowledgeDocumentDALRequest = Pick<
  KnowledgeDocument,
  "companyId" | "publicId"
>;

// DEV_NOTE: The documents a sync works through (upload sources), oldest first. indexStatuses null = any.
export type GetKnowledgeDocumentsBySourceDALRequest = GetKnowledgeDocumentsCountDALRequest & {
  indexStatuses: KnowledgeDocumentIndexStatusIntEnum[] | null;
  limit: number;
};

// DEV_NOTE: An upload source's documents a sync has work for: Pending or Failed, or indexed by an older pipeline
// (content_hash without contentHashPrefix). Oldest first.
export type GetKnowledgeDocumentsToIndexDALRequest = GetKnowledgeDocumentsCountDALRequest & {
  contentHashPrefix: string;
  limit: number;
};

// DEV_NOTE: A web source's documents whose URL the latest listing no longer has (removed from the sitemap)
export type GetUnlistedKnowledgeDocumentsDALRequest = GetKnowledgeDocumentsCountDALRequest & {
  listedSourceUrls: string[];
};

export type DeleteKnowledgeDocumentsDALRequest = Pick<KnowledgeDocument, "companyId"> & {
  ids: string[];
};

export type DeleteKnowledgeDocumentsBySourceDALRequest = GetKnowledgeDocumentsCountDALRequest;
