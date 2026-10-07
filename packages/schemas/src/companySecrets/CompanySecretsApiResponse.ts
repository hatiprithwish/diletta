import type { CompanySecretWithStatus } from "./CompanySecretsCommon";
import type { ApiResponse } from "../common";

export interface CreateCompanySecretApiResponse extends ApiResponse {
  companySecret?: CompanySecretWithStatus;
}

export interface GetCompanySecretApiResponse extends ApiResponse {
  companySecret?: CompanySecretWithStatus;
}

export interface GetCompanySecretsApiResponse extends ApiResponse {
  companySecrets?: CompanySecretWithStatus[];
}

export interface UpdateCompanySecretApiResponse extends ApiResponse {
  companySecret?: CompanySecretWithStatus;
}

// DEV_NOTE: Server-side only (model router, AuthStrategy) — never a route response body
export interface DecryptedCompanySecretResponse extends ApiResponse {
  secret?: string;
}
