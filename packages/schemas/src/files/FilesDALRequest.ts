import type { StoredFile } from "./FilesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId.
export type CreateFileDALRequest = Pick<
  StoredFile,
  "companyId" | "ownerType" | "ownerId" | "filename" | "mime" | "sizeBytes" | "sha256" | "createdBy"
>;

// DEV_NOTE: A file is created before its owner row when the owner needs the file's id (knowledge_documents.file_id
// is NOT NULL): this points it at the owner once that exists, in the same transaction.
export type SetFileOwnerDALRequest = Pick<StoredFile, "id" | "companyId" | "ownerType" | "ownerId">;

// DEV_NOTE: New bytes for the same file (a re-synced page whose content changed); the R2 object is overwritten at the
// same key. updatedAt is set by the DAL.
export type UpdateFileContentDALRequest = Pick<
  StoredFile,
  "id" | "companyId" | "mime" | "sizeBytes" | "sha256"
>;

export type FindFileDALRequest = Pick<StoredFile, "id" | "companyId">;

export type FindFilesDALRequest = Pick<StoredFile, "companyId"> & { ids: string[] };

export type DeleteFilesDALRequest = FindFilesDALRequest;
