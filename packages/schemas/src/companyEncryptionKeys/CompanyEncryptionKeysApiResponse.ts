import type { CompanyEncryptionKeyWithStatus } from "./CompanyEncryptionKeysCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: No ApiRequest file: key operations take only the server-resolved companyId, never a client body.
export interface GetCompanyEncryptionKeyApiResponse extends ApiResponse {
  companyEncryptionKey?: CompanyEncryptionKeyWithStatus;
}

export interface GetCompanyEncryptionKeysApiResponse extends ApiResponse {
  companyEncryptionKeys?: CompanyEncryptionKeyWithStatus[];
}

export interface RotateCompanyEncryptionKeyApiResponse extends ApiResponse {
  companyEncryptionKey?: CompanyEncryptionKeyWithStatus;
}
