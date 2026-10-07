import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import CryptoContext from "./CryptoContext";
import EnvelopeCrypto from "./EnvelopeCrypto";

// DEV_NOTE: Pure WebCrypto, so these run in Node with throwaway keys. The backend tests cover the real master key
// (MasterKeyProvider) and the company_encryption_keys rows.
async function newMasterKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function newCompanyKey(masterKey: CryptoKey, aad: string) {
  const created = await EnvelopeCrypto.createCompanyKey(masterKey, aad);
  if (!created.encryptedKey) throw new Error("Company key not created");
  const unwrapped = await EnvelopeCrypto.unwrapCompanyKey(masterKey, created.encryptedKey, aad);
  if (!unwrapped.companyKey) throw new Error("Company key not unwrapped");
  return { encryptedKey: created.encryptedKey, companyKey: unwrapped.companyKey };
}

const keyAad = CryptoContext.companyKey("42", 1);
const valueAad = CryptoContext.value(Schemas.EncryptedColumnEnum.CompanySecret, "42");

describe("EnvelopeCrypto company keys", () => {
  it("creates a company key encrypted by the master key and unwraps it as non-extractable", async () => {
    const masterKey = await newMasterKey();

    const created = await EnvelopeCrypto.createCompanyKey(masterKey, keyAad);
    expect(created.isSuccess).toBe(true);
    // iv (12) ‖ key (32) ‖ GCM tag (16)
    expect(created.encryptedKey?.byteLength).toBe(60);

    const unwrapped = await EnvelopeCrypto.unwrapCompanyKey(
      masterKey,
      created.encryptedKey ?? new Uint8Array(),
      keyAad,
    );
    expect(unwrapped.isSuccess).toBe(true);
    expect(unwrapped.companyKey?.extractable).toBe(false);
    expect(unwrapped.companyKey?.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(unwrapped.companyKey?.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("creates a different key every time", async () => {
    const masterKey = await newMasterKey();
    const first = await newCompanyKey(masterKey, keyAad);
    const second = await newCompanyKey(masterKey, keyAad);

    const encrypted = await EnvelopeCrypto.encryptValue(first.companyKey, "sk-test", valueAad);
    const crossed = await EnvelopeCrypto.decryptValue(
      second.companyKey,
      encrypted.encryptedValue!,
      valueAad,
    );
    expect(crossed).toEqual({ isSuccess: false, message: "Value could not be decrypted" });
  });

  it("refuses to unwrap with the wrong master key, another company or version, or tampered bytes", async () => {
    const masterKey = await newMasterKey();
    const { encryptedKey } = await newCompanyKey(masterKey, keyAad);
    const failed = { isSuccess: false, message: "Company key could not be decrypted" };

    expect(
      await EnvelopeCrypto.unwrapCompanyKey(await newMasterKey(), encryptedKey, keyAad),
    ).toEqual(failed);
    expect(
      await EnvelopeCrypto.unwrapCompanyKey(
        masterKey,
        encryptedKey,
        CryptoContext.companyKey("43", 1),
      ),
    ).toEqual(failed);
    expect(
      await EnvelopeCrypto.unwrapCompanyKey(
        masterKey,
        encryptedKey,
        CryptoContext.companyKey("42", 2),
      ),
    ).toEqual(failed);

    const tampered = new Uint8Array(encryptedKey);
    tampered[20] = tampered[20]! ^ 0xff;
    expect(await EnvelopeCrypto.unwrapCompanyKey(masterKey, tampered, keyAad)).toEqual(failed);

    expect(
      await EnvelopeCrypto.unwrapCompanyKey(masterKey, encryptedKey.subarray(0, 59), keyAad),
    ).toEqual({ isSuccess: false, message: "Encrypted company key is malformed" });
  });

  it("rewraps a company key under a new master key without changing the company key", async () => {
    const oldMasterKey = await newMasterKey();
    const newMaster = await newMasterKey();
    const { encryptedKey, companyKey } = await newCompanyKey(oldMasterKey, keyAad);
    const encrypted = await EnvelopeCrypto.encryptValue(companyKey, "sk-before-rewrap", valueAad);

    const rewrapped = await EnvelopeCrypto.rewrapCompanyKey(
      oldMasterKey,
      newMaster,
      encryptedKey,
      keyAad,
    );
    expect(rewrapped.isSuccess).toBe(true);
    expect(rewrapped.encryptedKey).not.toEqual(encryptedKey);

    // Only the new master key opens it now, and values encrypted before the rewrap still decrypt
    const withOld = await EnvelopeCrypto.unwrapCompanyKey(
      oldMasterKey,
      rewrapped.encryptedKey!,
      keyAad,
    );
    expect(withOld.isSuccess).toBe(false);
    const withNew = await EnvelopeCrypto.unwrapCompanyKey(
      newMaster,
      rewrapped.encryptedKey!,
      keyAad,
    );
    expect(withNew.isSuccess).toBe(true);
    const decrypted = await EnvelopeCrypto.decryptValue(
      withNew.companyKey!,
      encrypted.encryptedValue!,
      valueAad,
    );
    expect(decrypted.plaintext).toBe("sk-before-rewrap");
  });

  it("refuses to rewrap with the wrong old master key", async () => {
    const masterKey = await newMasterKey();
    const { encryptedKey } = await newCompanyKey(masterKey, keyAad);

    const rewrapped = await EnvelopeCrypto.rewrapCompanyKey(
      await newMasterKey(),
      await newMasterKey(),
      encryptedKey,
      keyAad,
    );
    expect(rewrapped).toEqual({ isSuccess: false, message: "Company key could not be decrypted" });
  });
});

describe("EnvelopeCrypto values", () => {
  it("round-trips text, including multi-byte characters and JSON", async () => {
    const { companyKey } = await newCompanyKey(await newMasterKey(), keyAad);

    for (const plaintext of [
      "sk-ant-api03-abcdef",
      "pässwörd 🔑",
      JSON.stringify({ a: [1, 2] }),
      "",
    ]) {
      const encrypted = await EnvelopeCrypto.encryptValue(companyKey, plaintext, valueAad);
      expect(encrypted.isSuccess).toBe(true);
      expect(encrypted.encryptedValue?.iv.byteLength).toBe(12);

      const decrypted = await EnvelopeCrypto.decryptValue(
        companyKey,
        encrypted.encryptedValue!,
        valueAad,
      );
      expect(decrypted).toEqual({
        isSuccess: true,
        message: "Value decrypted successfully",
        plaintext,
      });
    }
  });

  it("uses a fresh iv every time, so equal values never produce equal ciphertexts", async () => {
    const { companyKey } = await newCompanyKey(await newMasterKey(), keyAad);

    const first = await EnvelopeCrypto.encryptValue(companyKey, "same", valueAad);
    const second = await EnvelopeCrypto.encryptValue(companyKey, "same", valueAad);
    expect(first.encryptedValue?.iv).not.toEqual(second.encryptedValue?.iv);
    expect(first.encryptedValue?.ciphertext).not.toEqual(second.encryptedValue?.ciphertext);
  });

  // DEV_NOTE: pg returns bytea as a Node Buffer, often a view at an offset into a larger shared pool
  it("decrypts values read back as views into a larger buffer", async () => {
    const { companyKey } = await newCompanyKey(await newMasterKey(), keyAad);
    const encrypted = await EnvelopeCrypto.encryptValue(companyKey, "from-postgres", valueAad);
    const asPooledView = (bytes: Uint8Array) => {
      const pool = crypto.getRandomValues(new Uint8Array(bytes.byteLength + 64));
      pool.set(bytes, 32);
      return pool.subarray(32, 32 + bytes.byteLength);
    };

    const decrypted = await EnvelopeCrypto.decryptValue(
      companyKey,
      {
        ciphertext: asPooledView(encrypted.encryptedValue!.ciphertext),
        iv: asPooledView(encrypted.encryptedValue!.iv),
      },
      valueAad,
    );
    expect(decrypted.plaintext).toBe("from-postgres");
  });

  it("refuses a value moved to another company or column, or tampered with", async () => {
    const { companyKey } = await newCompanyKey(await newMasterKey(), keyAad);
    const encrypted = await EnvelopeCrypto.encryptValue(companyKey, "sk-test", valueAad);
    const value = encrypted.encryptedValue!;
    const failed = { isSuccess: false, message: "Value could not be decrypted" };

    expect(
      await EnvelopeCrypto.decryptValue(
        companyKey,
        value,
        CryptoContext.value(Schemas.EncryptedColumnEnum.CompanySecret, "43"),
      ),
    ).toEqual(failed);
    expect(
      await EnvelopeCrypto.decryptValue(
        companyKey,
        value,
        CryptoContext.value(Schemas.EncryptedColumnEnum.ChatbotUserSecret, "42"),
      ),
    ).toEqual(failed);

    const tampered = new Uint8Array(value.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(
      await EnvelopeCrypto.decryptValue(companyKey, { ...value, ciphertext: tampered }, valueAad),
    ).toEqual(failed);

    expect(
      await EnvelopeCrypto.decryptValue(
        companyKey,
        { ...value, iv: value.iv.subarray(0, 8) },
        valueAad,
      ),
    ).toEqual({ isSuccess: false, message: "Encrypted value is malformed" });
  });

  it("re-encrypts a value from an old company key version to a new one", async () => {
    const masterKey = await newMasterKey();
    const v1 = await newCompanyKey(masterKey, CryptoContext.companyKey("42", 1));
    const v2 = await newCompanyKey(masterKey, CryptoContext.companyKey("42", 2));
    const encrypted = await EnvelopeCrypto.encryptValue(v1.companyKey, "rotate-me", valueAad);

    const reEncrypted = await EnvelopeCrypto.reEncryptValue(
      v1.companyKey,
      v2.companyKey,
      encrypted.encryptedValue!,
      valueAad,
    );
    expect(reEncrypted.isSuccess).toBe(true);
    expect(reEncrypted.encryptedValue?.iv).not.toEqual(encrypted.encryptedValue?.iv);

    const withNew = await EnvelopeCrypto.decryptValue(
      v2.companyKey,
      reEncrypted.encryptedValue!,
      valueAad,
    );
    expect(withNew.plaintext).toBe("rotate-me");
    const withOld = await EnvelopeCrypto.decryptValue(
      v1.companyKey,
      reEncrypted.encryptedValue!,
      valueAad,
    );
    expect(withOld.isSuccess).toBe(false);
  });

  it("refuses to re-encrypt a value the old key can't decrypt", async () => {
    const masterKey = await newMasterKey();
    const v1 = await newCompanyKey(masterKey, keyAad);
    const v2 = await newCompanyKey(masterKey, keyAad);
    const encrypted = await EnvelopeCrypto.encryptValue(v1.companyKey, "rotate-me", valueAad);

    const reEncrypted = await EnvelopeCrypto.reEncryptValue(
      v2.companyKey,
      v1.companyKey,
      encrypted.encryptedValue!,
      valueAad,
    );
    expect(reEncrypted).toEqual({ isSuccess: false, message: "Value could not be decrypted" });
  });
});
