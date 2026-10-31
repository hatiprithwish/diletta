import { z } from "zod";
import {
  KNOWLEDGE_UPLOAD_MAX_BYTES,
  ZKnowledgeDocumentSortColumn,
  resolveKnowledgeUploadMime,
} from "./KnowledgeDocumentsCommon";
import { ZPageApiRequest } from "../common";

// DEV_NOTE: multipart/form-data with one file field (zValidator("form", …)). z.instanceof(File), not z.file(): zod's
// File type falls back to an empty interface outside the DOM lib (the worker), which hides name and type.
export const ZUploadKnowledgeDocumentApiRequest = z.object({
  file: z
    .instanceof(File)
    .refine((file) => file.size > 0, { message: "File is empty" })
    .refine((file) => file.size <= KNOWLEDGE_UPLOAD_MAX_BYTES, { message: "File is too large" })
    .refine((file) => resolveKnowledgeUploadMime(file) !== null, {
      message: "Unsupported file type",
    }),
});
export type UploadKnowledgeDocumentApiRequest = z.infer<typeof ZUploadKnowledgeDocumentApiRequest>;

// DEV_NOTE: Text the Knowledge page's document picker (M4-7) looks for in titles, case-insensitive; blank = every document
export const KNOWLEDGE_DOCUMENT_SEARCH_MAX_CHARS = 200;
export const ZKnowledgeDocumentSearch = z
  .string()
  .trim()
  .max(KNOWLEDGE_DOCUMENT_SEARCH_MAX_CHARS)
  .transform((search) => (search === "" ? undefined : search))
  .optional();

// DEV_NOTE: GET …/documents/count with the list's search, so the pages add up
export const ZGetKnowledgeDocumentsCountApiRequest = z.object({
  search: ZKnowledgeDocumentSearch,
});
export type GetKnowledgeDocumentsCountApiRequest = z.infer<
  typeof ZGetKnowledgeDocumentsCountApiRequest
>;

// DEV_NOTE: A sitemap source can hold hundreds of documents, so the list is paged
export const ZGetKnowledgeDocumentsApiRequest = ZPageApiRequest.extend({
  sortColumn: ZKnowledgeDocumentSortColumn.nullable().optional(),
  search: ZKnowledgeDocumentSearch,
});
export type GetKnowledgeDocumentsApiRequest = z.infer<typeof ZGetKnowledgeDocumentsApiRequest>;
