import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
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
  // their own encryption_key_version; new writes use the new key.
  async rotateCompanyEncryptionKey(params: {
    companyId: string;
  }): Promise<Schemas.RotateCompanyEncryptionKeyApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const listed = await this.dal.getCompanyEncryptionKeys(tx, params);
      if (!listed.isSuccess || !listed.companyEncryptionKeys) {
        throw new TenantRollbackError(listed.message);
      }

      const companyEncryptionKeys = listed.companyEncryptionKeys;
      if (
        companyEncryptionKeys.some(
          (key) => key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
        )
      ) {
        throw new TenantRollbackError("Key rotation already in progress");
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
      if (!created.isSuccess) {
        throw new TenantRollbackError(created.message);
      }

      return this.withCompanyEncryptionKeyResponse(created);
    });
  }
}
