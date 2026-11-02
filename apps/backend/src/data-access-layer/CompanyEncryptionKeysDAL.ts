import { and, asc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, companyEncryptionKeys } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: One version number per company, and at most one active key per company
const VERSION_INDEX = "UNQ_company_encryption_keys_company_id_version";
const ACTIVE_INDEX = "UNQ_company_encryption_keys_company_id_active";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant (withPlatform when
// createCompany adds the first key), and every query filters on companyId (defence in depth on top of RLS).
// It stores and returns encrypted_key as-is: encrypting and decrypting it is CompanyKeyProvider's job.
// encryptedKey is key material, so it never goes into log metadata, even encrypted.
export default class CompanyEncryptionKeysDAL {
  async createCompanyEncryptionKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateCompanyEncryptionKeyDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeyDALResponse = { isSuccess: false };
    const { encryptedKey: _encryptedKey, ...metadata } = params;

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateCompanyEncryptionKey,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [companyEncryptionKeyResponse] = await tx
        .insert(companyEncryptionKeys)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          version: params.version,
          encryptedKey: Buffer.from(params.encryptedKey),
          masterKeyVersion: params.masterKeyVersion,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Encryption key created successfully";
      response.companyEncryptionKey = companyEncryptionKeyResponse;
    } catch (error) {
      let message = "Unknown error in creating encryption key";
      if (Utility.isUniqueViolation(error, VERSION_INDEX)) {
        message = "Encryption key version already exists";
      } else if (Utility.isUniqueViolation(error, ACTIVE_INDEX)) {
        message = "Company already has an active encryption key";
      }
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateCompanyEncryptionKey,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: By version — how a row's encryption_key_version finds the key that encrypted it
  async getCompanyEncryptionKeyDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindCompanyEncryptionKeyDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeyDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyEncryptionKeys.version, params.version),
        eq(companyEncryptionKeys.companyId, params.companyId),
      ];
      const [companyEncryptionKey] = await tx
        .select()
        .from(companyEncryptionKeys)
        .where(and(...conditions))
        .limit(1);

      if (!companyEncryptionKey) {
        const message = "Encryption key not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetCompanyEncryptionKeyDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Encryption key fetched successfully";
      response.companyEncryptionKey = companyEncryptionKey;
    } catch (error) {
      const message = "Unknown error in fetching encryption key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyEncryptionKeyDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The key every new encrypted_* value is written with (UNQ_company_encryption_keys_company_id_active).
  // isForShare: a read that waited on a rotation's lock re-checks the old row, now Retiring, and finds nothing; the
  // statement's snapshot can't see the key the rotation created, so it reads once more, as a new statement that does.
  async getActiveCompanyEncryptionKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetActiveCompanyEncryptionKeyDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeyDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyEncryptionKeys.companyId, params.companyId),
        eq(companyEncryptionKeys.status, Schemas.CompanyEncryptionKeyStatusIntEnum.Active),
      ];
      const readActiveKey = async () => {
        const query = tx
          .select()
          .from(companyEncryptionKeys)
          .where(and(...conditions))
          .limit(1);
        const [row] = params.isForShare ? await query.for("share") : await query;
        return row;
      };
      let companyEncryptionKey = await readActiveKey();
      if (!companyEncryptionKey && params.isForShare) {
        companyEncryptionKey = await readActiveKey();
      }

      if (!companyEncryptionKey) {
        const message = "Active encryption key not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetActiveCompanyEncryptionKey,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Active encryption key fetched successfully";
      response.companyEncryptionKey = companyEncryptionKey;
    } catch (error) {
      const message = "Unknown error in fetching active encryption key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetActiveCompanyEncryptionKey,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Not paged: one row per rotation, so a company has a handful at most
  async getCompanyEncryptionKeys(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompanyEncryptionKeysDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeysDALResponse = { isSuccess: false };

    try {
      const query = tx
        .select()
        .from(companyEncryptionKeys)
        .where(eq(companyEncryptionKeys.companyId, params.companyId))
        .orderBy(asc(companyEncryptionKeys.version));
      const companyEncryptionKeysResponse = params.isForUpdate
        ? await query.for("update")
        : await query;

      response.isSuccess = true;
      response.message = "Encryption keys fetched successfully";
      response.companyEncryptionKeys = companyEncryptionKeysResponse;
    } catch (error) {
      const message = "Unknown error in listing encryption keys";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListCompanyEncryptionKeys,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Matches only the active key, so a concurrent rotation that already moved it finds nothing and rolls back
  async markCompanyEncryptionKeyRetiring(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.MarkCompanyEncryptionKeyRetiringDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeyDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyEncryptionKeys.version, params.version),
        eq(companyEncryptionKeys.companyId, params.companyId),
        eq(companyEncryptionKeys.status, Schemas.CompanyEncryptionKeyStatusIntEnum.Active),
      ];
      const [companyEncryptionKeyResponse] = await tx
        .update(companyEncryptionKeys)
        .set({
          status: Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!companyEncryptionKeyResponse) {
        const message = "Active encryption key not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.MarkCompanyEncryptionKeyRetiring,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Encryption key marked retiring successfully";
      response.companyEncryptionKey = companyEncryptionKeyResponse;
    } catch (error) {
      const message = "Unknown error in marking encryption key retiring";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.MarkCompanyEncryptionKeyRetiring,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Platform read (withPlatform) for the rotation job (M6-3): every company with a Retiring key or a live key
  // wrapped by an older master key. Destroyed keys have nothing left to re-wrap, so they never count.
  async getCompanyIdsWithKeyWork(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompanyIdsWithKeyWorkDALRequest,
  ) {
    const response: Schemas.CompanyIdsDALResponse = { isSuccess: false };

    try {
      const liveOnOldMasterKey = [
        ne(companyEncryptionKeys.status, Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed),
        lt(companyEncryptionKeys.masterKeyVersion, params.masterKeyVersion),
      ];
      const conditions = [
        or(
          eq(companyEncryptionKeys.status, Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring),
          and(...liveOnOldMasterKey),
        ),
      ];
      if (params.companyIds) {
        conditions.push(inArray(companyEncryptionKeys.companyId, params.companyIds));
      }
      const rows = await tx
        .selectDistinct({ companyId: companyEncryptionKeys.companyId })
        .from(companyEncryptionKeys)
        .where(and(...conditions))
        .orderBy(asc(companyEncryptionKeys.companyId));

      response.isSuccess = true;
      response.message = "Companies with key work fetched successfully";
      response.companyIds = rows.map((row) => row.companyId);
    } catch (error) {
      const message = "Unknown error in listing companies with key work";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyIdsWithKeyWork,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Compare-and-set on master_key_version: a key re-wrapped or destroyed since the read matches nothing, which
  // answers isNotFound (nothing written, not an error to retry)
  async rewrapCompanyEncryptionKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.RewrapCompanyEncryptionKeyDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeyDALResponse = { isSuccess: false };
    const { encryptedKey: _encryptedKey, ...metadata } = params;

    try {
      const conditions = [
        eq(companyEncryptionKeys.version, params.version),
        eq(companyEncryptionKeys.companyId, params.companyId),
        eq(companyEncryptionKeys.masterKeyVersion, params.fromMasterKeyVersion),
        ne(companyEncryptionKeys.status, Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed),
      ];
      const [companyEncryptionKeyResponse] = await tx
        .update(companyEncryptionKeys)
        .set({
          encryptedKey: Buffer.from(params.encryptedKey),
          masterKeyVersion: params.masterKeyVersion,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!companyEncryptionKeyResponse) {
        response.isNotFound = true;
        response.message = "Encryption key already re-wrapped or destroyed";
        return response;
      }

      response.isSuccess = true;
      response.message = "Encryption key re-wrapped successfully";
      response.companyEncryptionKey = companyEncryptionKeyResponse;
    } catch (error) {
      const message = "Unknown error in re-wrapping encryption key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.RewrapCompanyEncryptionKey,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The crypto-shred. Only a Retiring key matches; the row stays (its version is never reused).
  async destroyCompanyEncryptionKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DestroyCompanyEncryptionKeyDALRequest,
  ) {
    const response: Schemas.CompanyEncryptionKeyDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyEncryptionKeys.version, params.version),
        eq(companyEncryptionKeys.companyId, params.companyId),
        eq(companyEncryptionKeys.status, Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring),
      ];
      const now = new Date();
      const [companyEncryptionKeyResponse] = await tx
        .update(companyEncryptionKeys)
        .set({
          status: Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed,
          encryptedKey: null,
          destroyedAt: now,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning();

      if (!companyEncryptionKeyResponse) {
        const message = "Retiring encryption key not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DestroyCompanyEncryptionKey,
          message,
          metadata: params,
        });
        response.isNotFound = true;
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Encryption key destroyed successfully";
      response.companyEncryptionKey = companyEncryptionKeyResponse;
    } catch (error) {
      const message = "Unknown error in destroying encryption key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DestroyCompanyEncryptionKey,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
