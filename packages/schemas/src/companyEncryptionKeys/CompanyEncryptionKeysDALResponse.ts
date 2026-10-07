import type { CompanyEncryptionKey } from "./CompanyEncryptionKeysCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints). The Repo maps them to API responses.
export interface CompanyEncryptionKeyDALResponse extends ApiResponse {
  companyEncryptionKey?: CompanyEncryptionKey;
}

export interface CompanyEncryptionKeysDALResponse extends ApiResponse {
  companyEncryptionKeys?: CompanyEncryptionKey[];
}
