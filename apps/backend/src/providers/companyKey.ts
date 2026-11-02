import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { CryptoContext, EnvelopeCrypto } from "@app/crypto";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import AppLogger from "@/providers/logger";
import MasterKeyProvider from "@/providers/masterKey";

// DEV_NOTE: The one place a company key is created or decrypted, and the only path from a Repo to @app/crypto for
// encrypted_* values. It calls CompanyEncryptionKeysDAL directly with the caller's tx (a provider
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

  // DEV_NOTE: The key new values are encrypted with; version goes into the row's encryption_key_version. Read FOR SHARE
  // (M6-3): the caller's transaction holds the key Active until it commits, so a rotation waits for its write and the
  // rotation job never counts a key empty while a value is still being written under it.
  static async getActiveCompanyKey(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string },
  ): Promise<Schemas.VersionedCompanyKeyResponse> {
    const result = await CompanyKeyProvider.dal.getActiveCompanyEncryptionKey(tx, {
      companyId: params.companyId,
      isForShare: true,
    });
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
    return await CompanyKeyProvider.decryptWithKey(companyKey.companyKey, params);
  }

  private static async decryptWithKey(
    key: NonNullable<Schemas.VersionedCompanyKeyResponse["companyKey"]>,
    params: {
      companyId: string;
      column: Schemas.EncryptedColumnEnum;
      encryptedValue: Schemas.EncryptedValue;
      encryptionKeyVersion: number;
    },
  ): Promise<Schemas.DecryptValueResponse> {
    const decrypted = await EnvelopeCrypto.decryptValue(
      key,
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

  // DEV_NOTE: decryptValue for several values of one company and column (a list): each key version is fetched and
  // unwrapped once. Results in input order; a value that fails is a failed entry (logged), the rest still decrypt.
  static async decryptValues(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      column: Schemas.EncryptedColumnEnum;
      values: { encryptedValue: Schemas.EncryptedValue; encryptionKeyVersion: number }[];
    },
  ): Promise<Schemas.DecryptValueResponse[]> {
    const keys = new Map<number, Schemas.VersionedCompanyKeyResponse>();
    const results: Schemas.DecryptValueResponse[] = [];
    for (const value of params.values) {
      let companyKey = keys.get(value.encryptionKeyVersion);
      if (!companyKey) {
        companyKey = await CompanyKeyProvider.getCompanyKey(env, tx, {
          companyId: params.companyId,
          version: value.encryptionKeyVersion,
        });
        keys.set(value.encryptionKeyVersion, companyKey);
      }
      if (!companyKey.isSuccess || !companyKey.companyKey) {
        results.push({ isSuccess: false, message: companyKey.message });
        continue;
      }
      results.push(
        await CompanyKeyProvider.decryptWithKey(companyKey.companyKey, {
          companyId: params.companyId,
          column: params.column,
          encryptedValue: value.encryptedValue,
          encryptionKeyVersion: value.encryptionKeyVersion,
        }),
      );
    }
    return results;
  }

  // DEV_NOTE: Key rotation job (M6-3): a batch of one company's values in one column, moved from fromVersion to the
  // active key. Both keys are read and unwrapped once; each value is decrypted and encrypted again with a fresh iv
  // (EnvelopeCrypto.reEncryptValue), so plaintext never leaves this call. A value that fails is a failed entry (logged
  // by id), the rest still re-encrypt.
  static async reEncryptValues(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      column: Schemas.EncryptedColumnEnum;
      fromVersion: number;
      values: Schemas.ValueOnKeyVersion[];
    },
  ): Promise<Schemas.ReEncryptValuesResponse> {
    const oldKey = await CompanyKeyProvider.getCompanyKey(env, tx, {
      companyId: params.companyId,
      version: params.fromVersion,
    });
    if (!oldKey.isSuccess || !oldKey.companyKey) {
      return { isSuccess: false, message: oldKey.message };
    }
    const activeKey = await CompanyKeyProvider.getActiveCompanyKey(env, tx, {
      companyId: params.companyId,
    });
    if (!activeKey.isSuccess || !activeKey.companyKey || activeKey.version === undefined) {
      return { isSuccess: false, message: activeKey.message };
    }

    const aad = CryptoContext.value(params.column, params.companyId);
    const results: Schemas.ReEncryptedValue[] = [];
    for (const value of params.values) {
      const reEncrypted = await EnvelopeCrypto.reEncryptValue(
        oldKey.companyKey,
        activeKey.companyKey,
        value.encryptedValue,
        aad,
      );
      if (!reEncrypted.isSuccess || !reEncrypted.encryptedValue) {
        AppLogger.error({
          category: Schemas.LogCategory.Crypto,
          action: Schemas.LogAction.ReEncryptValue,
          message: reEncrypted.message ?? "Value could not be re-encrypted",
          metadata: {
            companyId: params.companyId,
            column: params.column,
            id: value.id,
            fromVersion: params.fromVersion,
            encryptionKeyVersion: activeKey.version,
          },
        });
        results.push({ id: value.id, isSuccess: false });
        continue;
      }
      results.push({ id: value.id, isSuccess: true, encryptedValue: reEncrypted.encryptedValue });
    }

    return {
      isSuccess: true,
      message: "Values re-encrypted",
      encryptionKeyVersion: activeKey.version,
      results,
    };
  }

  // DEV_NOTE: Master key rotation (M6-3, docs/runbooks/master-key.md): the same company key, wrapped again under
  // masterKeyVersion. The company key doesn't change, so no encrypted_* value moves. The DAL writes only while the row is
  // still on the master key it was read with (isNotFound otherwise: re-wrapped or destroyed since).
  static async rewrapCompanyKey(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyEncryptionKey: Schemas.CompanyEncryptionKey; masterKeyVersion: number },
  ): Promise<Schemas.CompanyEncryptionKeyDALResponse> {
    const key = params.companyEncryptionKey;
    const metadata = {
      companyId: key.companyId,
      version: key.version,
      fromMasterKeyVersion: key.masterKeyVersion,
      masterKeyVersion: params.masterKeyVersion,
    };
    if (key.encryptedKey === null) {
      return { isSuccess: false, isNotFound: true, message: "Encryption key destroyed" };
    }

    const oldMasterKey = await MasterKeyProvider.getMasterKey(env, key.masterKeyVersion);
    if (!oldMasterKey.masterKey) {
      return { isSuccess: false, message: oldMasterKey.message };
    }
    const newMasterKey = await MasterKeyProvider.getMasterKey(env, params.masterKeyVersion);
    if (!newMasterKey.masterKey) {
      return { isSuccess: false, message: newMasterKey.message };
    }

    const rewrapped = await EnvelopeCrypto.rewrapCompanyKey(
      oldMasterKey.masterKey,
      newMasterKey.masterKey,
      key.encryptedKey,
      CryptoContext.companyKey(key.companyId, key.version),
    );
    if (!rewrapped.isSuccess || !rewrapped.encryptedKey) {
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.RewrapCompanyKey,
        message: rewrapped.message ?? "Company key could not be re-wrapped",
        metadata,
      });
      return { isSuccess: false, message: rewrapped.message };
    }

    return await CompanyKeyProvider.dal.rewrapCompanyEncryptionKey(tx, {
      companyId: key.companyId,
      version: key.version,
      fromMasterKeyVersion: key.masterKeyVersion,
      masterKeyVersion: params.masterKeyVersion,
      encryptedKey: rewrapped.encryptedKey,
    });
  }

  // DEV_NOTE: The one way to read a company_secrets value (CompanySecretsRepo, the model router): decrypts the row's
  // ciphertext with its own key version. The plaintext goes back to a server-side caller only.
  static async decryptCompanySecret(
    env: Env,
    tx: NodePgTransaction<EmptyRelations>,
    companySecret: Schemas.CompanySecret,
  ): Promise<Schemas.DecryptedCompanySecretResponse> {
    const decrypted = await CompanyKeyProvider.decryptValue(env, tx, {
      companyId: companySecret.companyId,
      column: Schemas.EncryptedColumnEnum.CompanySecret,
      encryptedValue: { ciphertext: companySecret.encryptedSecret, iv: companySecret.iv },
      encryptionKeyVersion: companySecret.encryptionKeyVersion,
    });
    if (!decrypted.isSuccess || decrypted.plaintext === undefined) {
      return { isSuccess: false, message: decrypted.message };
    }

    return {
      isSuccess: true,
      message: "Company secret decrypted successfully",
      secret: decrypted.plaintext,
    };
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
