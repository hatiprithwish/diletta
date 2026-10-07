import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Number of trailing characters kept in plaintext for display (last_four_chars)
const VISIBLE_SECRET_CHARS = 4;

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId and connectionId are internal ids, resolved server-side; never from the client. The secret is
// encrypted under the company's active key before the DAL sees it; only getDecryptedCompanySecret returns the
// plaintext, to server-side callers (model router, AuthStrategy), never in a route response.
export default class CompanySecretsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: CompanySecretsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new CompanySecretsDAL();
  }

  private withStatusLabel(companySecret: Schemas.CompanySecret): Schemas.CompanySecretWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      connectionId: _connectionId,
      encryptedSecret: _encryptedSecret,
      iv: _iv,
      encryptionKeyVersion: _encryptionKeyVersion,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      ...rest
    } = companySecret;
    return {
      ...rest,
      companySecretStatus: companySecret.status,
      companySecretStatusLabel: Schemas.COMPANY_SECRET_STATUS_LABEL_MAP[companySecret.status],
      companySecretType: companySecret.type,
      companySecretTypeLabel: Schemas.COMPANY_SECRET_TYPE_LABEL_MAP[companySecret.type],
    };
  }

  private withCompanySecretResponse(
    result: Schemas.CompanySecretDALResponse,
  ): Schemas.GetCompanySecretApiResponse {
    const { companySecret, ...rest } = result;
    return {
      ...rest,
      companySecret: companySecret ? this.withStatusLabel(companySecret) : undefined,
    };
  }

  async createCompanySecret(
    params: Schemas.CreateCompanySecretApiRequest & {
      companyId: string;
      connectionId: string | null;
    },
  ): Promise<Schemas.CreateCompanySecretApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companySecret } = params;
      const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
        companyId: params.companyId,
        column: Schemas.EncryptedColumnEnum.CompanySecret,
        plaintext: companySecret.secret,
      });
      if (
        !encrypted.isSuccess ||
        !encrypted.encryptedValue ||
        encrypted.encryptionKeyVersion === undefined
      ) {
        return { isSuccess: false, message: encrypted.message };
      }

      const result = await this.dal.createCompanySecret(tx, {
        companyId: params.companyId,
        type: companySecret.type,
        provider: companySecret.provider,
        connectionId: params.connectionId,
        encryptedSecret: encrypted.encryptedValue.ciphertext,
        iv: encrypted.encryptedValue.iv,
        encryptionKeyVersion: encrypted.encryptionKeyVersion,
        lastFourChars: companySecret.secret.slice(-VISIBLE_SECRET_CHARS),
        expiresAt: companySecret.expiresAt ?? null,
      });
      return this.withCompanySecretResponse(result);
    });
  }

  async getCompanySecretDetails(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetCompanySecretApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getCompanySecretDetails(tx, params);
      return this.withCompanySecretResponse(result);
    });
  }

  async getCompanySecrets(params: {
    companyId: string;
  }): Promise<Schemas.GetCompanySecretsApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companySecrets, ...rest } = await this.dal.getCompanySecrets(tx, params);
      return {
        ...rest,
        companySecrets: companySecrets?.map((companySecret) => this.withStatusLabel(companySecret)),
      };
    });
  }

  // DEV_NOTE: A new secret value overwrites the row under the company's active key (and its version), so a value
  // replaced after a key rotation also moves to the new key. The caller validates the new value first.
  async updateCompanySecret(
    params: Schemas.UpdateCompanySecretApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.UpdateCompanySecretApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companySecret } = params;
      let encryptedValue: Schemas.EncryptedValue | null = null;
      let encryptionKeyVersion: number | null = null;

      if (companySecret.secret !== undefined) {
        const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
          companyId: params.companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          plaintext: companySecret.secret,
        });
        if (
          !encrypted.isSuccess ||
          !encrypted.encryptedValue ||
          encrypted.encryptionKeyVersion === undefined
        ) {
          return { isSuccess: false, message: encrypted.message };
        }
        encryptedValue = encrypted.encryptedValue;
        encryptionKeyVersion = encrypted.encryptionKeyVersion;
      }

      const result = await this.dal.updateCompanySecret(tx, {
        companyId: params.companyId,
        publicId: params.publicId,
        encryptedSecret: encryptedValue?.ciphertext ?? null,
        iv: encryptedValue?.iv ?? null,
        encryptionKeyVersion,
        lastFourChars: companySecret.secret?.slice(-VISIBLE_SECRET_CHARS) ?? null,
        expiresAt: companySecret.expiresAt ?? null,
        status: companySecret.status ?? null,
      });
      return this.withCompanySecretResponse(result);
    });
  }

  // DEV_NOTE: Server-side only. Decrypts with the row's own encryption_key_version, so it reads values written
  // before a rotation too. Never return this response from a route.
  async getDecryptedCompanySecret(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.DecryptedCompanySecretResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getCompanySecretDetails(tx, params);
      if (!result.isSuccess || !result.companySecret) {
        return { isSuccess: false, message: result.message };
      }

      const { companySecret } = result;
      const decrypted = await CompanyKeyProvider.decryptValue(this.env, tx, {
        companyId: params.companyId,
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
    });
  }
}
