import type { NullableDALFields } from "../common";
import type { CompanySecret, ModelProviderEnum } from "./CompanySecretsCommon";

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
> & {
  encryptedSecret: Uint8Array;
  iv: Uint8Array;
  // DEV_NOTE: Settings › Model keys (M4-10): when the provider accepted the value, and who added it
  lastValidatedAt?: Date | null;
  createdBy?: string | null;
};

// Params to find a company secret by its public ID within one company
export type FindCompanySecretDALRequest = Pick<CompanySecret, "publicId" | "companyId">;

// DEV_NOTE: isForUpdate locks the row (a key rotation, M4-10), so two rotations of one key run one after the other
export type GetCompanySecretDetailsDALRequest = FindCompanySecretDALRequest & {
  isForUpdate?: boolean;
};

export type GetCompanySecretsDALRequest = Pick<CompanySecret, "companyId">;

// DEV_NOTE: A new value replaces encryptedSecret, iv, encryptionKeyVersion and lastFourChars together, and the DAL
// sets rotatedAt. updatedAt is set by the DAL.
export type UpdateCompanySecretDALRequest = FindCompanySecretDALRequest &
  NullableDALFields<
    Pick<CompanySecret, "encryptionKeyVersion" | "lastFourChars" | "expiresAt" | "status"> & {
      encryptedSecret: Uint8Array;
      iv: Uint8Array;
    }
  > & {
    // DEV_NOTE: Settings › Model keys (M4-10): when the provider accepted the new value, and who rotated it
    lastValidatedAt?: Date | null;
    updatedBy?: string | null;
  };

// Params to find a company's active model key for one provider (at most one: UNQ_company_secrets_company_id_provider_active)
// DEV_NOTE: isForShare reads the row FOR SHARE (a publish, M4-10), so the key can't be invalidated, revoked or replaced
// between the publish's check and its commit
export type FindActiveModelKeyDALRequest = Pick<CompanySecret, "companyId"> & {
  provider: ModelProviderEnum;
  isForShare?: boolean;
};

// DEV_NOTE: The providers with an Active model key (the Bots editor's picker): providers only, never a value
export type GetActiveModelKeyProvidersDALRequest = Pick<CompanySecret, "companyId">;

// DEV_NOTE: Marks a model key Invalid only if the row still holds the exact value that was used (iv and key version
// change on every replacement) and is still Active, so a late rejection never touches a key the admin has replaced
// or revoked since.
export type InvalidateModelKeyDALRequest = Pick<
  CompanySecret,
  "companyId" | "publicId" | "iv" | "encryptionKeyVersion"
>;
