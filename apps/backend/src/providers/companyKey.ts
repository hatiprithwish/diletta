import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { CryptoContext, EnvelopeCrypto } from "@app/crypto";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import AppLogger from "@/providers/logger";
import MasterKeyProvider from "@/providers/masterKey";

// DEV_NOTE: The one place a company key is created or decrypted, and the only path from a Repo to @app/crypto for
// encrypted_* values. It calls CompanyEncryptionKeysDAL directly with the caller's tx (pattern rule 1.1: a provider
// may call a DAL inside the Repo's transaction, never opening one itself), so the secrets Repos encrypt and write in
// one withTenant. Keys stay non-extractable CryptoKeys in memory for one call; plaintext never reaches a log.
export default class CompanyKeyProvider {
  private static dal = new CompanyEncryptionKeysDAL();

  // DEV_NOTE: A new company key, encrypted by the current master key, stored as the company's active key.
  // createCompany adds version 1; rotation adds the next version after marking the old one retiring.
  static async createCompanyKey(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; version: number },
  ): Promise<Schemas.CompanyEncryptionKeyDALResponse> {
    const masterKeyVersion = Constants.CURRENT_MASTER_KEY_VERSION;
    const { masterKey, message: masterKeyMessage } = await MasterKeyProvider.getMasterKey(
      env,
      masterKeyVersion,
    );
    if (!masterKey) {
      return { isSuccess: false, message: masterKeyMessage };
    }

    const created = await EnvelopeCrypto.createCompanyKey(
      masterKey,
      CryptoContext.companyKey(params.companyId, params.version),
    );
    if (!created.isSuccess || !created.encryptedKey) {
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.CreateCompanyKey,
        message: created.message ?? "Company key could not be encrypted",
        metadata: { ...params, masterKeyVersion },
      });
      return { isSuccess: false, message: created.message };
    }

    return await CompanyKeyProvider.dal.createCompanyEncryptionKey(tx, {
      companyId: params.companyId,
      version: params.version,
      encryptedKey: created.encryptedKey,
      masterKeyVersion,
    });
  }

  // DEV_NOTE: The key new values are encrypted with; version goes into the row's encryption_key_version
  static async getActiveCompanyKey(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string },
  ): Promise<Schemas.VersionedCompanyKeyResponse> {
    const result = await CompanyKeyProvider.dal.getActiveCompanyEncryptionKey(tx, params);
    if (!result.isSuccess || !result.companyEncryptionKey) {
      return { isSuccess: false, message: result.message };
    }

    return await CompanyKeyProvider.unwrapCompanyKey(env, result.companyEncryptionKey);
  }

  // DEV_NOTE: The key a stored value was encrypted with (its encryption_key_version): active or retiring
  static async getCompanyKey(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; version: number },
  ): Promise<Schemas.VersionedCompanyKeyResponse> {
    const result = await CompanyKeyProvider.dal.getCompanyEncryptionKeyDetails(tx, params);
    if (!result.isSuccess || !result.companyEncryptionKey) {
      return { isSuccess: false, message: result.message };
    }

    return await CompanyKeyProvider.unwrapCompanyKey(env, result.companyEncryptionKey);
  }

  // DEV_NOTE: Encrypts under the company's active key; store encryptionKeyVersion next to the ciphertext and iv
  static async encryptValue(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; column: Schemas.EncryptedColumnEnum; plaintext: string },
  ): Promise<Schemas.CompanyEncryptValueResponse> {
    // DEV_NOTE: Only companyId goes down: the DAL logs its params on failure, and they must never hold the plaintext
    const activeKey = await CompanyKeyProvider.getActiveCompanyKey(env, tx, {
      companyId: params.companyId,
    });
    if (!activeKey.isSuccess || !activeKey.companyKey || activeKey.version === undefined) {
      return { isSuccess: false, message: activeKey.message };
    }

    const encrypted = await EnvelopeCrypto.encryptValue(
      activeKey.companyKey,
      params.plaintext,
      CryptoContext.value(params.column, params.companyId),
    );
    if (!encrypted.isSuccess || !encrypted.encryptedValue) {
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.EncryptValue,
        message: encrypted.message ?? "Value could not be encrypted",
        metadata: {
          companyId: params.companyId,
          column: params.column,
          encryptionKeyVersion: activeKey.version,
        },
      });
      return { isSuccess: false, message: encrypted.message };
    }

    return {
      isSuccess: true,
      message: encrypted.message,
      encryptedValue: encrypted.encryptedValue,
      encryptionKeyVersion: activeKey.version,
    };
  }

  // DEV_NOTE: Decrypts with the key version stored on the row, so values written before a rotation still read
  static async decryptValue(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      column: Schemas.EncryptedColumnEnum;
      encryptedValue: Schemas.EncryptedValue;
      encryptionKeyVersion: number;
    },
  ): Promise<Schemas.DecryptValueResponse> {
    const companyKey = await CompanyKeyProvider.getCompanyKey(env, tx, {
      companyId: params.companyId,
      version: params.encryptionKeyVersion,
    });
    if (!companyKey.isSuccess || !companyKey.companyKey) {
      return { isSuccess: false, message: companyKey.message };
    }

    const decrypted = await EnvelopeCrypto.decryptValue(
      companyKey.companyKey,
      params.encryptedValue,
      CryptoContext.value(params.column, params.companyId),
    );
    if (!decrypted.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.DecryptValue,
        message: decrypted.message ?? "Value could not be decrypted",
        metadata: {
          companyId: params.companyId,
          column: params.column,
          encryptionKeyVersion: params.encryptionKeyVersion,
        },
      });
    }

    return decrypted;
  }

  private static async unwrapCompanyKey(
    env: Env,
    companyEncryptionKey: Schemas.CompanyEncryptionKey,
  ): Promise<Schemas.VersionedCompanyKeyResponse> {
    const metadata = {
      companyId: companyEncryptionKey.companyId,
      version: companyEncryptionKey.version,
      masterKeyVersion: companyEncryptionKey.masterKeyVersion,
    };

    // DEV_NOTE: Crypto-shred: a destroyed key has no encrypted_key left, so its values can never be read again
    if (
      companyEncryptionKey.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed ||
      companyEncryptionKey.encryptedKey === null
    ) {
      const message = "Encryption key destroyed";
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.UnwrapCompanyKey,
        message,
        metadata,
      });
      return { isSuccess: false, message };
    }

    const { masterKey, message: masterKeyMessage } = await MasterKeyProvider.getMasterKey(
      env,
      companyEncryptionKey.masterKeyVersion,
    );
    if (!masterKey) {
      return { isSuccess: false, message: masterKeyMessage };
    }

    const unwrapped = await EnvelopeCrypto.unwrapCompanyKey(
      masterKey,
      companyEncryptionKey.encryptedKey,
      CryptoContext.companyKey(companyEncryptionKey.companyId, companyEncryptionKey.version),
    );
    if (!unwrapped.isSuccess || !unwrapped.companyKey) {
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.UnwrapCompanyKey,
        message: unwrapped.message ?? "Company key could not be decrypted",
        metadata,
      });
      return { isSuccess: false, message: unwrapped.message };
    }

    return {
      isSuccess: true,
      message: unwrapped.message,
      companyKey: unwrapped.companyKey,
      version: companyEncryptionKey.version,
    };
  }
}
