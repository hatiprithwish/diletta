import { z } from "zod";

// DEV_NOTE: What owns a file (files.owner_type, text in the DB): owner_id is that table's internal id. The file is
// purged with its owner (row + R2 object). Conversation images, eval transcripts and exports add theirs when they land.
export enum FileOwnerTypeEnum {
  KnowledgeDocument = "knowledge_document",
}

// Whole Stored File Body — DB shape
// DEV_NOTE: id, companyId, ownerId and createdBy are internal bigint ids — used by DAL/Repo only, NEVER sent to a
// client. sha256 is over the stored bytes (integrity + dedupe). The R2 key is derived, never stored:
// t/{company public_id}/{file public_id} (fileR2Key).
export const ZStoredFile = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  ownerType: z.enum(FileOwnerTypeEnum),
  ownerId: z.string(),
  filename: z.string().nullable(),
  mime: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type StoredFile = z.infer<typeof ZStoredFile>;

// DEV_NOTE: The one place the R2 object key of a file is built
export function fileR2Key(companyPublicId: string, filePublicId: string): string {
  return `t/${companyPublicId}/${filePublicId}`;
}
