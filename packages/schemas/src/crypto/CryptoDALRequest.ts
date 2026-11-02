import type { EncryptedValue } from "./CryptoCommon";

// DEV_NOTE: The rotation job's reads and writes on each encrypted_* table (M6-3). Every one filters on companyId (on top
// of RLS). A purged value (encrypted_* NULL) is never matched: it has nothing left to re-encrypt.

// DEV_NOTE: One batch of values still on encryptionKeyVersion, by id ascending after afterId (null = from the start), so
// a run walks past a value that fails instead of reading it again
export type GetValuesOnKeyVersionDALRequest = {
  companyId: string;
  encryptionKeyVersion: number;
  afterId: string | null;
  limit: number;
};

// DEV_NOTE: Compare-and-set: writes only while the row still holds fromEncryptionKeyVersion and fromIv (a fresh iv on
// every write), so a value rewritten since the read keeps its new value
export type UpdateReEncryptedValueDALRequest = {
  companyId: string;
  id: string;
  fromEncryptionKeyVersion: number;
  fromIv: Uint8Array;
  encryptedValue: EncryptedValue;
  encryptionKeyVersion: number;
};

export type CountValuesOnKeyVersionDALRequest = {
  companyId: string;
  encryptionKeyVersion: number;
};
