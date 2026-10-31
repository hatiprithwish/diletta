import type { CompanyEncryptionKey } from "./CompanyEncryptionKeysCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// encryptedKey is the company key already encrypted by the master key; plaintext key bytes never reach the DAL.
export type CreateCompanyEncryptionKeyDALRequest = Pick<
  CompanyEncryptionKey,
  "companyId" | "version" | "masterKeyVersion"
> & { encryptedKey: Uint8Array };

// Params to find a company key by version within one company (a row's encryption_key_version)
export type FindCompanyEncryptionKeyDALRequest = Pick<
  CompanyEncryptionKey,
  "companyId" | "version"
>;

export type GetActiveCompanyEncryptionKeyDALRequest = Pick<CompanyEncryptionKey, "companyId">;

// DEV_NOTE: isForUpdate locks the company's key rows for the rest of the transaction (SELECT … FOR UPDATE), so two
// rotations at once run one after the other and the second sees the first's Retiring key
export type GetCompanyEncryptionKeysDALRequest = Pick<CompanyEncryptionKey, "companyId"> & {
  isForUpdate?: boolean;
};

// DEV_NOTE: Rotation step one: the active key becomes retiring (only an active key matches)
export type MarkCompanyEncryptionKeyRetiringDALRequest = FindCompanyEncryptionKeyDALRequest;
