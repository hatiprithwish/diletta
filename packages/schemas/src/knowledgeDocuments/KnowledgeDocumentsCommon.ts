import z from "zod";

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

export enum KnowledgeDocumentSortColumn {
  CreatedAt = "createdAt",
  Title = "title",
  LastSyncedAt = "lastSyncedAt",
}

export const ZKnowledgeDocumentSortColumn = z.enum(KnowledgeDocumentSortColumn);

// DEV_NOTE: Files an admin may upload to an upload source, by extension → MIME type. Text formats (md, txt) are read
// as UTF-8; the rest go through Workers AI toMarkdown. A browser often sends no type (or octet-stream) for .md, so the
// extension decides when the type isn't one of these.
export const KNOWLEDGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};

// DEV_NOTE: The MIME type an upload is stored and read as, or null when the format isn't accepted
export function resolveKnowledgeUploadMime(file: { name: string; type: string }): string | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (Object.values(KNOWLEDGE_UPLOAD_MIME_BY_EXTENSION).includes(type)) {
    return type;
  }
  const extension = file.name.includes(".")
    ? (file.name.split(".").pop()?.toLowerCase() ?? "")
    : "";
  return Object.hasOwn(KNOWLEDGE_UPLOAD_MIME_BY_EXTENSION, extension)
    ? (KNOWLEDGE_UPLOAD_MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

// Whole Knowledge Document Body — DB shape (index status stored as integer)
// DEV_NOTE: id, companyId, knowledgeSourceId and fileId are internal bigint ids — used by DAL/Repo only, NEVER sent to
// a client. contentHash is the sha256 of the extracted text (not the bytes), so a re-sync skips an unchanged page.
export const ZKnowledgeDocument = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  knowledgeSourceId: z.string(),
  fileId: z.string(),
  title: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  contentHash: z.string().nullable(),
  indexStatus: z.enum(KnowledgeDocumentIndexStatusIntEnum),
  lastSyncedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type KnowledgeDocument = z.infer<typeof ZKnowledgeDocument>;

// API response shape — includes both int and label; internal ids are structurally omitted, publicId is client-facing
export type KnowledgeDocumentWithStatus = Omit<
  KnowledgeDocument,
  "id" | "companyId" | "knowledgeSourceId" | "fileId" | "contentHash"
> & {
  knowledgeDocumentIndexStatus: KnowledgeDocumentIndexStatusIntEnum;
  knowledgeDocumentIndexStatusLabel: KnowledgeDocumentIndexStatusLabelEnum;
};
