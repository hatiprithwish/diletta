import type { ApiResponse } from "../common";

// The master key comes back as a non-extractable WebCrypto key: callers can encrypt and
// decrypt with it, but can never read its bytes back out.
export interface MasterKeyResponse extends ApiResponse {
  masterKey?: CryptoKey;
}

// DEV_NOTE: The encrypted_* column each ciphertext belongs to. It goes into the AES-GCM additional data
// (with the company id), so a ciphertext copied to another column or another company fails to decrypt.
export enum EncryptedColumnEnum {
  CompanySecret = "company_secrets.encrypted_secret",
  ChatbotUserSecret = "chatbot_user_secrets.encrypted_secret",
  ToolCallArgs = "tool_calls.encrypted_args",
  ChangeRequestChanges = "change_requests.encrypted_changes",
}

// DEV_NOTE: An encrypted_* column value and the iv column next to it. Plain Uint8Array, so a Buffer read from
// Postgres fits; packages/crypto copies it into an ArrayBuffer-backed view before WebCrypto sees it.
export interface EncryptedValue {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

// A company key encrypted by the master key: company_encryption_keys.encrypted_key (iv ‖ ciphertext)
export interface EncryptedCompanyKeyResponse extends ApiResponse {
  encryptedKey?: Uint8Array<ArrayBuffer>;
}

// DEV_NOTE: Internal to packages/crypto — raw company key bytes, zeroed by the caller right after use
export interface CompanyKeyBytesResponse extends ApiResponse {
  bytes?: Uint8Array<ArrayBuffer>;
}

// A decrypted company key: non-extractable, like the master key
export interface CompanyKeyResponse extends ApiResponse {
  companyKey?: CryptoKey;
}

// DEV_NOTE: version is company_encryption_keys.version, stored on each row as encryption_key_version
export interface VersionedCompanyKeyResponse extends CompanyKeyResponse {
  version?: number;
}

export interface EncryptValueResponse extends ApiResponse {
  encryptedValue?: EncryptedValue;
}

// DEV_NOTE: Server-side only — the plaintext never goes into an API response or a log
export interface DecryptValueResponse extends ApiResponse {
  plaintext?: string;
}

// Value encrypted under a company's active key, with the version to store next to it.
// DEV_NOTE: A union, so one isSuccess check narrows to the ciphertext, iv and version together
export type CompanyEncryptValueResponse =
  | {
      isSuccess: true;
      message?: string;
      encryptedValue: EncryptedValue;
      encryptionKeyVersion: number;
    }
  | { isSuccess: false; message?: string };
