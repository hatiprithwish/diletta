import type {
  CompanySecretStatusIntEnum,
  CompanySecretStatusLabelEnum,
  CompanySecretWithStatus,
  ModelKeyFailureEnum,
  ModelProviderEnum,
} from "./CompanySecretsCommon";
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

// DEV_NOTE: A model key as Settings › Model keys shows it: the provider, the last four characters (empty for a short
// key), status, and when it was last checked with the provider. Never the value or its ciphertext.
export interface ModelKey {
  publicId: string;
  provider: ModelProviderEnum;
  providerLabel: string;
  lastFourChars: string;
  status: CompanySecretStatusIntEnum;
  statusLabel: CompanySecretStatusLabelEnum;
  lastValidatedAt: string | null; // ISO time
  rotatedAt: string | null; // ISO time
  createdAt: string; // ISO time
}

export interface GetModelKeysApiResponse extends ApiResponse {
  modelKeys?: ModelKey[];
}

export interface ModelKeyWriteApiResponse extends ApiResponse {
  modelKey?: ModelKey;
  failure?: ModelKeyFailureEnum;
}
