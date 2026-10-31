import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AiGatewayProvider from "@/providers/aiGateway";
import CompanyKeyProvider from "@/providers/companyKey";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Trailing characters kept in plaintext for display (last_four_chars), and only for a secret long enough
// that they reveal a small part of it. A shorter secret is stored with an empty last_four_chars.
const VISIBLE_SECRET_CHARS = 4;
const MIN_LENGTH_TO_SHOW_CHARS = 12;

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

  private visibleChars(secret: string): string {
    return secret.length >= MIN_LENGTH_TO_SHOW_CHARS ? secret.slice(-VISIBLE_SECRET_CHARS) : "";
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
      // DEV_NOTE: Mirrors CHK_company_secrets_connection_id, checked before anything is encrypted
      const isModelKey = companySecret.type === Schemas.CompanySecretTypeIntEnum.ModelKey;
      if (isModelKey !== (params.connectionId === null)) {
        return {
          isSuccess: false,
          message: isModelKey
            ? "A model key can't belong to a connection"
            : "A connection is required for this secret type",
        };
      }

      const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
        companyId: params.companyId,
        column: Schemas.EncryptedColumnEnum.CompanySecret,
        plaintext: companySecret.secret,
      });
      if (!encrypted.isSuccess) {
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
        lastFourChars: this.visibleChars(companySecret.secret),
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
        if (!encrypted.isSuccess) {
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
        lastFourChars:
          companySecret.secret === undefined ? null : this.visibleChars(companySecret.secret),
        expiresAt: companySecret.expiresAt ?? null,
        status: companySecret.status ?? null,
      });
      return this.withCompanySecretResponse(result);
    });
  }

  // DEV_NOTE: A model key as Settings › Model keys shows it, or null for a row that isn't one (another secret type, or
  // a provider this build doesn't know)
  private toModelKey(companySecret: Schemas.CompanySecret): Schemas.ModelKey | null {
    const provider = Schemas.ZModelProvider.safeParse(companySecret.provider);
    if (companySecret.type !== Schemas.CompanySecretTypeIntEnum.ModelKey || !provider.success) {
      return null;
    }
    return {
      publicId: companySecret.publicId,
      provider: provider.data,
      providerLabel: Schemas.MODEL_PROVIDER_LABEL_MAP[provider.data],
      lastFourChars: companySecret.lastFourChars,
      status: companySecret.status,
      statusLabel: Schemas.COMPANY_SECRET_STATUS_LABEL_MAP[companySecret.status],
      lastValidatedAt: companySecret.lastValidatedAt?.toISOString() ?? null,
      rotatedAt: companySecret.rotatedAt?.toISOString() ?? null,
      createdAt: companySecret.createdAt.toISOString(),
    };
  }

  // DEV_NOTE: The provider's verdict on a pasted key as a refusal, or null when it was accepted
  private modelKeyCheckRefusal(
    outcome: Schemas.ModelKeyCheckOutcomeEnum,
  ): Schemas.ModelKeyWriteApiResponse | null {
    switch (outcome) {
      case Schemas.ModelKeyCheckOutcomeEnum.Valid:
        return null;
      case Schemas.ModelKeyCheckOutcomeEnum.Rejected:
        return {
          isSuccess: false,
          message: "The provider rejected this key",
          failure: Schemas.ModelKeyFailureEnum.KeyRejected,
        };
      case Schemas.ModelKeyCheckOutcomeEnum.Unreachable:
        return {
          isSuccess: false,
          message: "The key couldn't be checked with the provider",
          failure: Schemas.ModelKeyFailureEnum.CheckUnavailable,
        };
    }
  }

  private activeKeyTaken(): Schemas.ModelKeyWriteApiResponse {
    return {
      isSuccess: false,
      message: "This provider already has an active key",
      failure: Schemas.ModelKeyFailureEnum.ProviderHasActiveKey,
    };
  }

  // DEV_NOTE: Settings › Model keys (M4-10): every model key, oldest first (a handful: one Active per provider)
  async getModelKeys(params: { companyId: string }): Promise<Schemas.GetModelKeysApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetModelKeysApiResponse> => {
        const result = await this.dal.getCompanySecrets(tx, params);
        if (!result.isSuccess || !result.companySecrets) {
          return { isSuccess: false, message: result.message };
        }
        return {
          isSuccess: true,
          message: "Model keys fetched successfully",
          modelKeys: result.companySecrets.flatMap((companySecret) => {
            const modelKey = this.toModelKey(companySecret);
            return modelKey ? [modelKey] : [];
          }),
        };
      },
    );
  }

  // DEV_NOTE: Add key (M4-10). A provider that already has an Active key is refused first (409, no provider call). Then
  // the provider checks the key (list-models through AI Gateway, outside the transaction: no lock held across a network
  // call); a refused or unchecked key saves nothing. Then one withTenant:
  // the provider's Active key looked up (one only: UNQ_company_secrets_company_id_provider_active, which also catches
  // a key added at the same moment), the value encrypted, the row Active with last_validated_at, and its Created audit
  // row labelled with the provider. The value is never logged or returned.
  async addModelKey(
    params: Schemas.AddModelKeyApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ModelKeyWriteApiResponse>> {
    // DEV_NOTE: The one-Active-key rule first, so a second Add answers 409 without a provider call; checked again in the
    // write's transaction (and by the unique index) for an Add at the same moment
    const existing: Schemas.CompanySecretDALResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.CompanySecretDALResponse> =>
        await this.dal.getActiveModelKey(tx, {
          companyId: params.companyId,
          provider: params.provider,
        }),
    );
    if (existing.isSuccess) return { ...this.activeKeyTaken(), outboxIds: [] };
    if (!existing.isNotFound) return { isSuccess: false, message: existing.message, outboxIds: [] };

    const outcome = await AiGatewayProvider.checkModelKey(this.env, {
      provider: params.provider,
      apiKey: params.secret,
    });
    const refusal = this.modelKeyCheckRefusal(outcome);
    if (refusal) return { ...refusal, outboxIds: [] };
    const validatedAt = new Date();

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ModelKeyWriteApiResponse>> => {
        const active = await this.dal.getActiveModelKey(tx, {
          companyId: params.companyId,
          provider: params.provider,
        });
        if (active.isSuccess) return { ...this.activeKeyTaken(), outboxIds: [] };
        if (!active.isNotFound) return { isSuccess: false, message: active.message, outboxIds: [] };

        const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
          companyId: params.companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          plaintext: params.secret,
        });
        if (!encrypted.isSuccess) {
          return { isSuccess: false, message: encrypted.message, outboxIds: [] };
        }

        const created = await this.dal.createCompanySecret(tx, {
          companyId: params.companyId,
          type: Schemas.CompanySecretTypeIntEnum.ModelKey,
          provider: params.provider,
          connectionId: null,
          encryptedSecret: encrypted.encryptedValue.ciphertext,
          iv: encrypted.encryptedValue.iv,
          encryptionKeyVersion: encrypted.encryptionKeyVersion,
          lastFourChars: this.visibleChars(params.secret),
          expiresAt: null,
          lastValidatedAt: validatedAt,
          createdBy: params.adminId,
        });
        if (created.isActiveKeyTaken) return { ...this.activeKeyTaken(), outboxIds: [] };
        const modelKey = created.companySecret ? this.toModelKey(created.companySecret) : null;
        if (!created.isSuccess || !created.companySecret || !modelKey) {
          return { isSuccess: false, message: created.message, outboxIds: [] };
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.ModelKey,
          entityAction: Schemas.AuditEntityActionEnum.Created,
          entity: created.companySecret,
          label: modelKey.providerLabel,
        });
        return {
          isSuccess: true,
          message: "Model key added successfully",
          modelKey,
          outboxIds: [outboxId],
        };
      },
    );
  }

  // DEV_NOTE: Rotate (M4-10): a new value for a model key, checked with the provider first like Add key. The row is
  // locked, so two rotations run one after the other; any status may be rotated (an Invalid or Revoked key comes back
  // Active), unless the provider has another Active key by then (409). The new value is encrypted under the company's
  // active key; rotated_at is set by the DAL. Its Rotated audit row is labelled with the provider.
  async rotateModelKey(
    params: Schemas.RotateModelKeyApiRequest & {
      companyId: string;
      adminId: string;
      publicId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.ModelKeyWriteApiResponse>> {
    const found: Schemas.CompanySecretDALResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.CompanySecretDALResponse> =>
        await this.dal.getCompanySecretDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
        }),
    );
    const foundKey = found.companySecret ? this.toModelKey(found.companySecret) : null;
    if (!found.isSuccess || !foundKey) {
      return {
        isSuccess: false,
        message: found.isSuccess ? "Model key not found" : found.message,
        isNotFound: found.isSuccess || found.isNotFound,
        outboxIds: [],
      };
    }

    const outcome = await AiGatewayProvider.checkModelKey(this.env, {
      provider: foundKey.provider,
      apiKey: params.secret,
    });
    const refusal = this.modelKeyCheckRefusal(outcome);
    if (refusal) return { ...refusal, outboxIds: [] };
    const validatedAt = new Date();

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ModelKeyWriteApiResponse>> => {
        const locked = await this.dal.getCompanySecretDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        const lockedKey = locked.companySecret ? this.toModelKey(locked.companySecret) : null;
        if (!locked.isSuccess || !lockedKey) {
          return {
            isSuccess: false,
            message: locked.isSuccess ? "Model key not found" : locked.message,
            isNotFound: locked.isSuccess || locked.isNotFound,
            outboxIds: [],
          };
        }

        const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
          companyId: params.companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          plaintext: params.secret,
        });
        if (!encrypted.isSuccess) {
          return { isSuccess: false, message: encrypted.message, outboxIds: [] };
        }

        const updated = await this.dal.updateCompanySecret(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          encryptedSecret: encrypted.encryptedValue.ciphertext,
          iv: encrypted.encryptedValue.iv,
          encryptionKeyVersion: encrypted.encryptionKeyVersion,
          lastFourChars: this.visibleChars(params.secret),
          expiresAt: null,
          status: Schemas.CompanySecretStatusIntEnum.Active,
          lastValidatedAt: validatedAt,
          updatedBy: params.adminId,
        });
        if (updated.isActiveKeyTaken) return { ...this.activeKeyTaken(), outboxIds: [] };
        const modelKey = updated.companySecret ? this.toModelKey(updated.companySecret) : null;
        if (!updated.isSuccess || !updated.companySecret || !modelKey) {
          // DEV_NOTE: The row was locked above, so a miss here is a server error, never a not-found
          throw new TenantRollbackError(updated.message ?? "Model key not rotated");
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.ModelKey,
          entityAction: Schemas.AuditEntityActionEnum.Rotated,
          entity: updated.companySecret,
          label: modelKey.providerLabel,
        });
        return {
          isSuccess: true,
          message: "Model key rotated successfully",
          modelKey,
          outboxIds: [outboxId],
        };
      },
    );
  }

  // DEV_NOTE: Server-side only. Decrypts with the row's own encryption_key_version, so it reads values written
  // before a rotation too. Only an active secret is handed out: an invalid or revoked one is never used again
  // until it is set active (after its value is replaced and validated). expiresAt is left to the caller. Never return this response from a route.
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
      if (companySecret.status !== Schemas.CompanySecretStatusIntEnum.Active) {
        return { isSuccess: false, message: "Company secret is not active" };
      }

      return await CompanyKeyProvider.decryptCompanySecret(this.env, tx, companySecret);
    });
  }
}
