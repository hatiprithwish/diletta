import type { StoredFile } from "./FilesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). Files are never returned to a client as-is.
export interface FileDALResponse extends ApiResponse {
  file?: StoredFile;
}

export interface FilesDALResponse extends ApiResponse {
  files?: StoredFile[];
}

// DEV_NOTE: A file with its company's public id, the other half of its R2 key (fileR2Key)
export interface FileWithCompanyDALResponse extends FileDALResponse {
  companyPublicId?: string;
}
