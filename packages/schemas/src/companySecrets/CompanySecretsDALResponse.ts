import type { CompanySecret } from "./CompanySecretsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints + ciphertext). The Repo maps them to API responses.
// DEV_NOTE: isActiveKeyTaken = the write hit UNQ_company_secrets_company_id_provider_active (another Active model key
// for the provider, e.g. added at the same moment)
export interface CompanySecretDALResponse extends ApiResponse {
  companySecret?: CompanySecret;
  isActiveKeyTaken?: boolean;
}

export interface CompanySecretsDALResponse extends ApiResponse {
  companySecrets?: CompanySecret[];
}

export interface ActiveModelKeyProvidersDALResponse extends ApiResponse {
  providers?: string[];
}
