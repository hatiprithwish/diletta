import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side; never from the client. The first key is created
// with the company (CompaniesRepo.createCompany). Rotation here is key-level only: re-encrypting every encrypted_*
// row to the new version and destroying the retiring key is the rotation job (M6-3).
export default class CompanyEncryptionKeysRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: CompanyEncryptionKeysDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new CompanyEncryptionKeysDAL();
  }

  private withStatusLabel(
    companyEncryptionKey: Schemas.CompanyEncryptionKey,
  ): Schemas.CompanyEncryptionKeyWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      encryptedKey: _encryptedKey,
      ...rest
    } = companyEncryptionKey;
    return {
      ...rest,
      companyEncryptionKeyStatus: companyEncryptionKey.status,
      companyEncryptionKeyStatusLabel:
        Schemas.COMPANY_ENCRYPTION_KEY_STATUS_LABEL_MAP[companyEncryptionKey.status],
    };
  }

  private withCompanyEncryptionKeyResponse(
    result: Schemas.CompanyEncryptionKeyDALResponse,
  ): Schemas.GetCompanyEncryptionKeyApiResponse {
    const { companyEncryptionKey, ...rest } = result;
    return {
      ...rest,
      companyEncryptionKey: companyEncryptionKey
        ? this.withStatusLabel(companyEncryptionKey)
        : undefined,
    };
  }

  async getActiveCompanyEncryptionKey(params: {
    companyId: string;
  }): Promise<Schemas.GetCompanyEncryptionKeyApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getActiveCompanyEncryptionKey(tx, params);
      return this.withCompanyEncryptionKeyResponse(result);
    });
  }

  async getCompanyEncryptionKeys(params: {
    companyId: string;
  }): Promise<Schemas.GetCompanyEncryptionKeysApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companyEncryptionKeys, ...rest } = await this.dal.getCompanyEncryptionKeys(
        tx,
        params,
      );
      return {
        ...rest,
        companyEncryptionKeys: companyEncryptionKeys?.map((companyEncryptionKey) =>
          this.withStatusLabel(companyEncryptionKey),
        ),
      };
    });
  }

  // DEV_NOTE: Transactional flow — the active key becomes retiring, then the next version is created active. Any
  // failed step throws TenantRollbackError, so the old key stays active. One rotation at a time (max 2 live keys):
  // refused while a retiring key is still waiting for the rotation job. Values already stored keep decrypting with
  // their own encryption_key_version; new writes use the new key. Only an admin rotates (the Security page, M4-9): the
  // rotation records its audit row in the same transaction; a refusal (failure, 409) writes nothing. The key rows are
  // locked first, so a second rotation at the same moment waits for the first and is refused as RotationInProgress.
  async rotateCompanyEncryptionKey(params: {
    companyId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.RotateCompanyEncryptionKeyApiResponse>> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const listed = await this.dal.getCompanyEncryptionKeys(tx, {
        companyId: params.companyId,
        isForUpdate: true,
      });
      if (!listed.isSuccess || !listed.companyEncryptionKeys) {
        throw new TenantRollbackError(listed.message);
      }

      const companyEncryptionKeys = listed.companyEncryptionKeys;
      if (
        companyEncryptionKeys.some(
          (key) => key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
        )
      ) {
        return {
          isSuccess: false,
          message: "Key rotation already in progress",
          failure: Schemas.EncryptionKeyRotateFailureEnum.RotationInProgress,
        };
      }

      const activeKey = companyEncryptionKeys.find(
        (key) => key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Active,
      );
      if (!activeKey) {
        throw new TenantRollbackError("Active encryption key not found");
      }

      const retired = await this.dal.markCompanyEncryptionKeyRetiring(tx, {
        companyId: params.companyId,
        version: activeKey.version,
      });
      if (!retired.isSuccess) {
        throw new TenantRollbackError(retired.message);
      }

      // DEV_NOTE: Destroyed versions keep their row, so the next version is past every one ever used
      const nextVersion = Math.max(...companyEncryptionKeys.map((key) => key.version)) + 1;
      const created = await CompanyKeyProvider.createCompanyKey(this.env, tx, {
        companyId: params.companyId,
        version: nextVersion,
      });
      if (!created.isSuccess || !created.companyEncryptionKey) {
        throw new TenantRollbackError(created.message);
      }

      const outboxId = await recordAuditOrRollback(tx, {
        companyId: params.companyId,
        actor: adminAuditActor(params.adminId),
        entityType: Schemas.AuditEntityTypeEnum.CompanyEncryptionKey,
        entityAction: Schemas.AuditEntityActionEnum.Rotated,
        entity: created.companyEncryptionKey,
        entityVersion: nextVersion,
        label: `v${nextVersion}`,
      });

      return { ...this.withCompanyEncryptionKeyResponse(created), outboxIds: [outboxId] };
    });
  }

  // DEV_NOTE: The Security page's keys (M4-9): every version, newest first, never its bytes or master key version.
  // rotatedAt = when it left Active: the next version's created_at (a rotation retires v<n> and creates v<n+1> in one
  // transaction), never updated_at, which later writes such as the M6-3 destroy move. A Retiring one means a rotation is
  // still in progress.
  async getSecurityEncryptionKeys(params: {
    companyId: string;
  }): Promise<Schemas.GetSecurityEncryptionKeysApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetSecurityEncryptionKeysApiResponse> => {
        const listed = await this.dal.getCompanyEncryptionKeys(tx, params);
        if (!listed.isSuccess || !listed.companyEncryptionKeys) {
          return { isSuccess: false, message: listed.message };
        }
        const keys = [...listed.companyEncryptionKeys].sort((a, b) => b.version - a.version);
        return {
          isSuccess: true,
          message: "Encryption keys fetched successfully",
          encryptionKeys: keys.map((key, index) => {
            const next = index > 0 ? keys[index - 1] : undefined;
            return {
              version: key.version,
              status: key.status,
              statusLabel: Schemas.COMPANY_ENCRYPTION_KEY_STATUS_LABEL_MAP[key.status],
              createdAt: key.createdAt.toISOString(),
              rotatedAt:
                key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Active || !next
                  ? null
                  : next.createdAt.toISOString(),
            };
          }),
          isRotationInProgress: keys.some(
            (key) => key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
          ),
        };
      },
    );
  }

  // DEV_NOTE: Rotate key from the Security page: the rotation, then the keys as they now stand (a refusal answers them as
  // they are, with its failure)
  async rotateFromDashboard(params: {
    companyId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.RotateEncryptionKeyApiResponse>> {
    const rotated = await this.rotateCompanyEncryptionKey(params);
    const failure = "failure" in rotated ? rotated.failure : undefined;
    // DEV_NOTE: A server error answers without the keys; only a refusal reads them, so the page shows why
    if (!rotated.isSuccess && !failure) return { isSuccess: false, message: rotated.message };
    const keys = await this.getSecurityEncryptionKeys({ companyId: params.companyId });
    if (!rotated.isSuccess) {
      return { ...keys, isSuccess: false, message: rotated.message, failure };
    }
    // DEV_NOTE: The rotation committed whatever the read does: a failed read still answers success, without the list
    // (the page reloads it)
    return {
      isSuccess: true,
      message: "Encryption key rotated",
      encryptionKeys: keys.encryptionKeys,
      isRotationInProgress: keys.isRotationInProgress,
      outboxIds: rotated.outboxIds,
    };
  }
}
