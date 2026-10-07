import { and, asc, eq } from "drizzle-orm";
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

  // DEV_NOTE: The key every new encrypted_* value is written with (UNQ_company_encryption_keys_company_id_active)
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
      const [companyEncryptionKey] = await tx
        .select()
        .from(companyEncryptionKeys)
        .where(and(...conditions))
        .limit(1);

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
      const companyEncryptionKeysResponse = await tx
        .select()
        .from(companyEncryptionKeys)
        .where(eq(companyEncryptionKeys.companyId, params.companyId))
        .orderBy(asc(companyEncryptionKeys.version));

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
}
