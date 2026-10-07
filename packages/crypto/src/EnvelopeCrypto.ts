import type * as Schemas from "@app/schemas";

// DEV_NOTE: Envelope encryption on WebCrypto AES-256-GCM. The master key (MasterKeyProvider) encrypts one company
// key per company; the company key encrypts the encrypted_* columns. Pure functions: no DB, no env, no logger.
// Every method returns { isSuccess, message } and never throws; messages never carry key or plaintext bytes, so
// the caller can log them as-is. Keys handed out are non-extractable (pattern rule 3.14).
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const TAG_BYTE_LENGTH = 16;
// DEV_NOTE: company_encryption_keys.encrypted_key has no iv column, so it stores iv ‖ ciphertext ‖ tag
const ENCRYPTED_KEY_BYTE_LENGTH = IV_BYTE_LENGTH + KEY_BYTE_LENGTH + TAG_BYTE_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export default class EnvelopeCrypto {
  // DEV_NOTE: A fresh company key, returned only encrypted by the master key. Its raw bytes exist inside this call
  // only and are zeroed before it returns. aad is CryptoContext.companyKey(companyId, version).
  static async createCompanyKey(
    masterKey: CryptoKey,
    aad: string,
  ): Promise<Schemas.EncryptedCompanyKeyResponse> {
    const response: Schemas.EncryptedCompanyKeyResponse = { isSuccess: false };
    const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH));

    try {
      response.encryptedKey = await EnvelopeCrypto.encryptKeyBytes(masterKey, rawKey, aad);
      response.isSuccess = true;
      response.message = "Company key created successfully";
    } catch {
      response.message = "Company key could not be encrypted";
    } finally {
      rawKey.fill(0);
    }

    return response;
  }

  // DEV_NOTE: Decrypts a stored company key into a non-extractable AES-GCM key. Fails on the wrong master key,
  // the wrong aad (another company or version) or a tampered value: GCM authenticates all three.
  static async unwrapCompanyKey(
    masterKey: CryptoKey,
    encryptedKey: Uint8Array,
    aad: string,
  ): Promise<Schemas.CompanyKeyResponse> {
    const response: Schemas.CompanyKeyResponse = { isSuccess: false };

    const rawKey = await EnvelopeCrypto.decryptKeyBytes(masterKey, encryptedKey, aad);
    if (!rawKey.isSuccess || !rawKey.bytes) {
      response.message = rawKey.message;
      return response;
    }

    try {
      response.companyKey = await crypto.subtle.importKey(
        "raw",
        rawKey.bytes,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      response.isSuccess = true;
      response.message = "Company key decrypted successfully";
    } catch {
      response.message = "Company key could not be decrypted";
    } finally {
      rawKey.bytes.fill(0);
    }

    return response;
  }

  // DEV_NOTE: Master key rotation (docs/runbooks/master-key.md): the same company key, encrypted again under the
  // new master key. The company key itself doesn't change, so no encrypted_* column needs re-encrypting.
  static async rewrapCompanyKey(
    oldMasterKey: CryptoKey,
    newMasterKey: CryptoKey,
    encryptedKey: Uint8Array,
    aad: string,
  ): Promise<Schemas.EncryptedCompanyKeyResponse> {
    const response: Schemas.EncryptedCompanyKeyResponse = { isSuccess: false };

    const rawKey = await EnvelopeCrypto.decryptKeyBytes(oldMasterKey, encryptedKey, aad);
    if (!rawKey.isSuccess || !rawKey.bytes) {
      response.message = rawKey.message;
      return response;
    }

    try {
      response.encryptedKey = await EnvelopeCrypto.encryptKeyBytes(newMasterKey, rawKey.bytes, aad);
      response.isSuccess = true;
      response.message = "Company key re-encrypted successfully";
    } catch {
      response.message = "Company key could not be encrypted";
    } finally {
      rawKey.bytes.fill(0);
    }

    return response;
  }

  // DEV_NOTE: aad is CryptoContext.value(column, companyId). A fresh random iv per call: never reuse one with a key.
  static async encryptValue(
    companyKey: CryptoKey,
    plaintext: string,
    aad: string,
  ): Promise<Schemas.EncryptValueResponse> {
    const response: Schemas.EncryptValueResponse = { isSuccess: false };

    try {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: textEncoder.encode(aad) },
        companyKey,
        textEncoder.encode(plaintext),
      );
      response.encryptedValue = { ciphertext: new Uint8Array(ciphertext), iv };
      response.isSuccess = true;
      response.message = "Value encrypted successfully";
    } catch {
      response.message = "Value could not be encrypted";
    }

    return response;
  }

  static async decryptValue(
    companyKey: CryptoKey,
    encryptedValue: Schemas.EncryptedValue,
    aad: string,
  ): Promise<Schemas.DecryptValueResponse> {
    const response: Schemas.DecryptValueResponse = { isSuccess: false };

    if (
      encryptedValue.iv.byteLength !== IV_BYTE_LENGTH ||
      encryptedValue.ciphertext.byteLength < TAG_BYTE_LENGTH
    ) {
      response.message = "Encrypted value is malformed";
      return response;
    }

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: EnvelopeCrypto.copyBytes(encryptedValue.iv),
          additionalData: textEncoder.encode(aad),
        },
        companyKey,
        EnvelopeCrypto.copyBytes(encryptedValue.ciphertext),
      );
      response.plaintext = textDecoder.decode(plaintext);
      response.isSuccess = true;
      response.message = "Value decrypted successfully";
    } catch {
      response.message = "Value could not be decrypted";
    }

    return response;
  }

  // DEV_NOTE: Company key rotation: decrypt under the old key version, encrypt under the new one with a fresh iv.
  // The row then stores the new ciphertext, iv and encryption_key_version together (rotation sweep, M6-3).
  static async reEncryptValue(
    oldCompanyKey: CryptoKey,
    newCompanyKey: CryptoKey,
    encryptedValue: Schemas.EncryptedValue,
    aad: string,
  ): Promise<Schemas.EncryptValueResponse> {
    const decrypted = await EnvelopeCrypto.decryptValue(oldCompanyKey, encryptedValue, aad);
    if (!decrypted.isSuccess || decrypted.plaintext === undefined) {
      return { isSuccess: false, message: decrypted.message };
    }

    return await EnvelopeCrypto.encryptValue(newCompanyKey, decrypted.plaintext, aad);
  }

  // DEV_NOTE: Throws on failure; callers catch and zero rawKey themselves
  private static async encryptKeyBytes(
    masterKey: CryptoKey,
    rawKey: Uint8Array<ArrayBuffer>,
    aad: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: textEncoder.encode(aad) },
      masterKey,
      rawKey,
    );

    const encryptedKey = new Uint8Array(ENCRYPTED_KEY_BYTE_LENGTH);
    encryptedKey.set(iv, 0);
    encryptedKey.set(new Uint8Array(ciphertext), IV_BYTE_LENGTH);
    return encryptedKey;
  }

  // DEV_NOTE: The caller owns the returned bytes and must zero them
  private static async decryptKeyBytes(
    masterKey: CryptoKey,
    encryptedKey: Uint8Array,
    aad: string,
  ): Promise<Schemas.CompanyKeyBytesResponse> {
    if (encryptedKey.byteLength !== ENCRYPTED_KEY_BYTE_LENGTH) {
      return { isSuccess: false, message: "Encrypted company key is malformed" };
    }

    try {
      const stored = EnvelopeCrypto.copyBytes(encryptedKey);
      const rawKey = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: stored.subarray(0, IV_BYTE_LENGTH),
          additionalData: textEncoder.encode(aad),
        },
        masterKey,
        stored.subarray(IV_BYTE_LENGTH),
      );
      return {
        isSuccess: true,
        message: "Company key decrypted successfully",
        bytes: new Uint8Array(rawKey),
      };
    } catch {
      return { isSuccess: false, message: "Company key could not be decrypted" };
    }
  }

  // DEV_NOTE: Bytes read from Postgres arrive as a Node Buffer, which may sit on a shared pool ArrayBuffer.
  // WebCrypto takes ArrayBuffer-backed views, so copy into one of exactly the right size.
  private static copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(bytes);
  }
}
