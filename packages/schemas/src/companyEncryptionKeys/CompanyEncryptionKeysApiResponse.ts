import type { EncryptionKeyRotateFailureEnum } from "../security/SecurityCommon";
import type { CompanyEncryptionKeyWithStatus } from "./CompanyEncryptionKeysCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: No ApiRequest file: key operations take only the server-resolved companyId, never a client body.
export interface GetCompanyEncryptionKeyApiResponse extends ApiResponse {
  companyEncryptionKey?: CompanyEncryptionKeyWithStatus;
}

export interface GetCompanyEncryptionKeysApiResponse extends ApiResponse {
  companyEncryptionKeys?: CompanyEncryptionKeyWithStatus[];
}

// DEV_NOTE: failure = why nothing changed (409): a previous rotation is still in progress (M4-9)
export interface RotateCompanyEncryptionKeyApiResponse extends ApiResponse {
  companyEncryptionKey?: CompanyEncryptionKeyWithStatus;
  failure?: EncryptionKeyRotateFailureEnum;
}
