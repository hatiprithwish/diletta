import type { NullableDALFields } from "../common";
import type { CompanySecret } from "./CompanySecretsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The secret arrives already encrypted by the Repo; plaintext never reaches the DAL.
export type CreateCompanySecretDALRequest = Pick<
  CompanySecret,
  | "companyId"
  | "type"
  | "provider"
  | "connectionId"
  | "encryptionKeyVersion"
  | "lastFourChars"
  | "expiresAt"
> & { encryptedSecret: Uint8Array; iv: Uint8Array };

// Params to find a company secret by its public ID within one company
export type FindCompanySecretDALRequest = Pick<CompanySecret, "publicId" | "companyId">;

export type GetCompanySecretsDALRequest = Pick<CompanySecret, "companyId">;

// DEV_NOTE: A new value replaces encryptedSecret, iv, encryptionKeyVersion and lastFourChars together, and the DAL
// sets rotatedAt. updatedAt is set by the DAL.
export type UpdateCompanySecretDALRequest = FindCompanySecretDALRequest &
  NullableDALFields<
    Pick<CompanySecret, "encryptionKeyVersion" | "lastFourChars" | "expiresAt" | "status"> & {
      encryptedSecret: Uint8Array;
      iv: Uint8Array;
    }
  >;
