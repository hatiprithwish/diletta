import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Local dev + vitest read MASTER_KEY_V<n> as a plain string from .dev.vars; staging and
// production bind the same name to a Secrets Store secret. Rotation adds MASTER_KEY_V<n+1>: a new
// binding in wrangler.jsonc, a new entry in getSource, and a bump of Constants.CURRENT_MASTER_KEY_VERSION.
type MasterKeySource = string | SecretsStoreSecret;

const MASTER_KEY_BYTE_LENGTH = 32;

export default class MasterKeyProvider {
  // DEV_NOTE: version is company_encryption_keys.master_key_version — the key that wrapped that row.
  static async getMasterKey(env: Env, version: number): Promise<Schemas.MasterKeyResponse> {
    const response: Schemas.MasterKeyResponse = { isSuccess: false };

    const source = MasterKeyProvider.getSource(env, version);
    if (!source) {
      const message = `Master key version ${version} is not configured`;
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.ReadMasterKey,
        message,
        metadata: { version },
      });
      response.message = message;
      return response;
    }

    try {
      const encoded = typeof source === "string" ? source : await source.get();
      const rawKey = MasterKeyProvider.decodeBase64(encoded.trim());

      if (rawKey === null || rawKey.byteLength !== MASTER_KEY_BYTE_LENGTH) {
        const message = `Master key version ${version} is not base64 of ${MASTER_KEY_BYTE_LENGTH} bytes`;
        AppLogger.error({
          category: Schemas.LogCategory.Crypto,
          action: Schemas.LogAction.ReadMasterKey,
          message,
          metadata: { version },
        });
        response.message = message;
        return response;
      }

      response.masterKey = await crypto.subtle.importKey(
        "raw",
        rawKey,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      );
      response.isSuccess = true;
      response.message = "Master key read successfully";
    } catch (error) {
      const message = `Unknown error in reading master key version ${version}`;
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.ReadMasterKey,
        message,
        error,
        metadata: { version },
      });
      response.message = message;
    }

    return response;
  }

  private static getSource(env: Env, version: number): MasterKeySource | undefined {
    switch (version) {
      case 1:
        return env.MASTER_KEY_V1;
      default:
        return undefined;
    }
  }

  private static decodeBase64(encoded: string): Uint8Array<ArrayBuffer> | null {
    try {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }
}
