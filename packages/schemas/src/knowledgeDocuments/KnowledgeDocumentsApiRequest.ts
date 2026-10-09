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

// DEV_NOTE: A sitemap source can hold hundreds of documents, so the list is paged
export const ZGetKnowledgeDocumentsApiRequest = ZPageApiRequest.extend({
  sortColumn: ZKnowledgeDocumentSortColumn.nullable().optional(),
});
export type GetKnowledgeDocumentsApiRequest = z.infer<typeof ZGetKnowledgeDocumentsApiRequest>;
