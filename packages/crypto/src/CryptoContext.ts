import type * as Schemas from "@app/schemas";

// DEV_NOTE: Builds the AES-GCM additional data (aad) that binds each ciphertext to where it is stored. It isn't
// secret and isn't stored: decryption rebuilds it from the row, so a ciphertext copied to another company, column
// or key version fails GCM authentication instead of decrypting. Changing a format breaks every stored value.
export default class CryptoContext {
  // company_encryption_keys.encrypted_key of one company and key version
  static companyKey(companyId: string, version: number): string {
    return `company_encryption_keys.encrypted_key:${companyId}:${version}`;
  }

  // An encrypted_* column value of one company
  static value(column: Schemas.EncryptedColumnEnum, companyId: string): string {
    return `${column}:${companyId}`;
  }
}
