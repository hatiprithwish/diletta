import type { StoredFile } from "./FilesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// publicId comes from the caller (Utility.generatePublicId), unlike other tables: the R2 object is named by it and is
// written before its row, so a source lock is never held while bytes upload.
export type CreateFileDALRequest = Pick<
  StoredFile,
  | "publicId"
  | "companyId"
  | "ownerType"
  | "ownerId"
  | "filename"
  | "mime"
  | "sizeBytes"
  | "sha256"
  | "createdBy"
>;

// DEV_NOTE: A file is created before its owner row when the owner needs the file's id (knowledge_documents.file_id
// is NOT NULL): this points it at the owner once that exists, in the same transaction.
export type SetFileOwnerDALRequest = Pick<StoredFile, "id" | "companyId" | "ownerType" | "ownerId">;

export type FindFileDALRequest = Pick<StoredFile, "id" | "companyId">;

export type DeleteFilesDALRequest = Pick<StoredFile, "companyId"> & { ids: string[] };
