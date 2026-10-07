import type { CompanySecret } from "./CompanySecretsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints + ciphertext). The Repo maps them to API responses.
export interface CompanySecretDALResponse extends ApiResponse {
  companySecret?: CompanySecret;
}

export interface CompanySecretsDALResponse extends ApiResponse {
  companySecrets?: CompanySecret[];
}
