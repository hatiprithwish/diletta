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

// DEV_NOTE: isForShare locks the active key row FOR SHARE until the transaction ends (M6-3): a value encrypted under it
// commits before a rotation (FOR UPDATE) can move it to Retiring, so no value lands on a key the rotation job already
// counted empty
export type GetActiveCompanyEncryptionKeyDALRequest = Pick<CompanyEncryptionKey, "companyId"> & {
  isForShare?: boolean;
};

// DEV_NOTE: isForUpdate locks the company's key rows for the rest of the transaction (SELECT … FOR UPDATE), so two
// rotations at once run one after the other and the second sees the first's Retiring key
export type GetCompanyEncryptionKeysDALRequest = Pick<CompanyEncryptionKey, "companyId"> & {
  isForUpdate?: boolean;
};

// DEV_NOTE: Rotation step one: the active key becomes retiring (only an active key matches)
export type MarkCompanyEncryptionKeyRetiringDALRequest = FindCompanyEncryptionKeyDALRequest;

// DEV_NOTE: The rotation job's list across companies (withPlatform, M6-3): companies with a Retiring key, or with a key
// still wrapped by a master key older than masterKeyVersion. companyIds null = every company, else only those.
export type GetCompanyIdsWithKeyWorkDALRequest = {
  companyIds: string[] | null;
  masterKeyVersion: number;
};

// DEV_NOTE: Master key rotation: the same company key, wrapped again. Matches only a live (not Destroyed) key still on
// fromMasterKeyVersion, so a concurrent re-wrap or destroy finds nothing and writes nothing.
export type RewrapCompanyEncryptionKeyDALRequest = FindCompanyEncryptionKeyDALRequest & {
  fromMasterKeyVersion: number;
  masterKeyVersion: number;
  encryptedKey: Uint8Array;
};

// DEV_NOTE: Rotation's last step: a Retiring key is destroyed (encrypted_key nulled, the crypto-shred). Only a Retiring
// key matches.
export type DestroyCompanyEncryptionKeyDALRequest = FindCompanyEncryptionKeyDALRequest;
