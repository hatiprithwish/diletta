import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import MasterKeyProvider from "@/providers/masterKey";
import Constants from "@/config/Constants";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Locally MASTER_KEY_V1 comes from apps/backend/.dev.vars (the staging key value).
// Deployed envs read the same binding name from Secrets Store; the provider handles both.
describe("MasterKeyProvider", () => {
  it("reads the current master key as a non-extractable AES-256-GCM key", async () => {
    const response = await MasterKeyProvider.getMasterKey(
      env,
      Constants.CURRENT_MASTER_KEY_VERSION,
    );

    expect(response.isSuccess).toBe(true);
    expect(response.masterKey?.extractable).toBe(false);
    expect(response.masterKey?.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(response.masterKey?.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("round-trips data through the master key", async () => {
    const { masterKey } = await MasterKeyProvider.getMasterKey(
      env,
      Constants.CURRENT_MASTER_KEY_VERSION,
    );
    if (!masterKey) throw new Error("Master key not read");

    const plaintext = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, masterKey, ciphertext);

    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });

  it("reads a Secrets Store binding the same way as a .dev.vars string", async () => {
    const fromSecretsStore = { get: vi.fn().mockResolvedValue(env.MASTER_KEY_V1) };

    const response = await MasterKeyProvider.getMasterKey(
      { ...env, MASTER_KEY_V1: fromSecretsStore },
      1,
    );

    expect(fromSecretsStore.get).toHaveBeenCalledOnce();
    expect(response.isSuccess).toBe(true);
  });

  it("returns an error for an unknown version", async () => {
    const response = await MasterKeyProvider.getMasterKey(env, 999);

    expect(response.isSuccess).toBe(false);
    expect(response.masterKey).toBeUndefined();
    expect(response.message).toBe("Master key version 999 is not configured");
  });

  it("returns an error when the key is not 32 bytes", async () => {
    const shortKey = btoa("too-short");

    const response = await MasterKeyProvider.getMasterKey({ ...env, MASTER_KEY_V1: shortKey }, 1);

    expect(response.isSuccess).toBe(false);
    expect(response.masterKey).toBeUndefined();
    expect(response.message).toBe("Master key version 1 is not base64 of 32 bytes");
  });

  it("returns an error when the key is not base64", async () => {
    const response = await MasterKeyProvider.getMasterKey(
      { ...env, MASTER_KEY_V1: "not base64 !!" },
      1,
    );

    expect(response.isSuccess).toBe(false);
    expect(response.message).toBe("Master key version 1 is not base64 of 32 bytes");
  });

  it("returns an error when Secrets Store fails", async () => {
    const failingSecretsStore = { get: vi.fn().mockRejectedValue(new Error("Secret not found")) };

    const response = await MasterKeyProvider.getMasterKey(
      { ...env, MASTER_KEY_V1: failingSecretsStore },
      1,
    );

    expect(response.isSuccess).toBe(false);
    expect(response.message).toBe("Unknown error in reading master key version 1");
  });
});
