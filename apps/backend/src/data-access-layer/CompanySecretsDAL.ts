import { and, asc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, companyConnections, companySecrets } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: One active model key per provider, and one active credential per connection and type
const PROVIDER_ACTIVE_INDEX = "UNQ_company_secrets_company_id_provider_active";
const CONNECTION_TYPE_ACTIVE_INDEX = "UNQ_company_secrets_company_id_connection_id_type_active";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). The secret arrives already encrypted
// by the Repo and leaves encrypted; ciphertext and iv never go into log metadata.
export default class CompanySecretsDAL {
  private uniqueViolationMessage(error: unknown, fallback: string): string {
    if (Utility.isUniqueViolation(error, PROVIDER_ACTIVE_INDEX)) {
      return "Active model key already exists for this provider";
    }
    if (Utility.isUniqueViolation(error, CONNECTION_TYPE_ACTIVE_INDEX)) {
      return "Active secret of this type already exists for this connection";
    }
    return fallback;
  }

  async createCompanySecret(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateCompanySecretDALRequest,
  ) {
    const response: Schemas.CompanySecretDALResponse = { isSuccess: false };
    const { encryptedSecret: _encryptedSecret, iv: _iv, ...metadata } = params;

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateCompanySecret,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      if (params.connectionId !== null) {
        const connectionConditions = [
          eq(companyConnections.id, params.connectionId),
          eq(companyConnections.companyId, params.companyId),
        ];
        const [connection] = await tx
          .select({ credentialScope: companyConnections.credentialScope })
          .from(companyConnections)
          .where(and(...connectionConditions))
          .limit(1);

        if (!connection) {
          const message = "Company connection not found";
          AppLogger.error({
            category: Schemas.LogCategory.DAL,
            action: Schemas.LogAction.CreateCompanySecret,
            message,
            metadata,
          });
          response.message = message;
          return response;
        }

        // DEV_NOTE: Only a company-scoped connection takes a company credential (credential_scope)
        if (
          connection.credentialScope !== Schemas.CompanyConnectionCredentialScopeIntEnum.Company
        ) {
          const message = "Connection doesn't take company secrets";
          AppLogger.error({
            category: Schemas.LogCategory.DAL,
            action: Schemas.LogAction.CreateCompanySecret,
            message,
            metadata,
          });
          response.message = message;
          return response;
        }
      }

      const [companySecretResponse] = await tx
        .insert(companySecrets)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          type: params.type,
          provider: params.provider,
          connectionId: params.connectionId,
          encryptedSecret: Buffer.from(params.encryptedSecret),
          iv: Buffer.from(params.iv),
          encryptionKeyVersion: params.encryptionKeyVersion,
          lastFourChars: params.lastFourChars,
          expiresAt: params.expiresAt,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Company secret created successfully";
      response.companySecret = companySecretResponse;
    } catch (error) {
      const message = this.uniqueViolationMessage(
        error,
        "Unknown error in creating company secret",
      );
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateCompanySecret,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async getCompanySecretDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindCompanySecretDALRequest,
  ) {
    const response: Schemas.CompanySecretDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companySecrets.publicId, params.publicId),
        eq(companySecrets.companyId, params.companyId),
      ];
      const [companySecret] = await tx
        .select()
        .from(companySecrets)
        .where(and(...conditions))
        .limit(1);

      if (!companySecret) {
        const message = "Company secret not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetCompanySecretDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company secret fetched successfully";
      response.companySecret = companySecret;
    } catch (error) {
      const message = "Unknown error in fetching company secret";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanySecretDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The model router's key lookup. Only an active row: an invalid or revoked key is never used again until
  // an admin replaces it. isNotFound when the company has no active key for the provider: an expected state (the
  // router opens a system issue for it), so it's a warning, not an error.
  async getActiveModelKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindActiveModelKeyDALRequest,
  ) {
    const response: Schemas.CompanySecretDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companySecrets.companyId, params.companyId),
        eq(companySecrets.type, Schemas.CompanySecretTypeIntEnum.ModelKey),
        eq(companySecrets.provider, params.provider),
        eq(companySecrets.status, Schemas.CompanySecretStatusIntEnum.Active),
      ];
      const [companySecret] = await tx
        .select()
        .from(companySecrets)
        .where(and(...conditions))
        .limit(1);

      if (!companySecret) {
        const message = "No active model key for this provider";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetActiveModelKey,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Active model key fetched successfully";
      response.companySecret = companySecret;
    } catch (error) {
      const message = "Unknown error in fetching active model key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetActiveModelKey,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The model router's key-failure path. Updates only while the row still holds the value that was used
  // (same iv and key version) and is Active. No match is a success with no companySecret: the admin replaced or
  // revoked the key since the call, so there is nothing to invalidate.
  async invalidateModelKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.InvalidateModelKeyDALRequest,
  ) {
    const response: Schemas.CompanySecretDALResponse = { isSuccess: false };
    const { iv: _iv, ...metadata } = params;

    try {
      const conditions = [
        eq(companySecrets.publicId, params.publicId),
        eq(companySecrets.companyId, params.companyId),
        eq(companySecrets.type, Schemas.CompanySecretTypeIntEnum.ModelKey),
        eq(companySecrets.status, Schemas.CompanySecretStatusIntEnum.Active),
        eq(companySecrets.iv, Buffer.from(params.iv)),
        eq(companySecrets.encryptionKeyVersion, params.encryptionKeyVersion),
      ];
      const [companySecret] = await tx
        .update(companySecrets)
        .set({ status: Schemas.CompanySecretStatusIntEnum.Invalid, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = companySecret
        ? "Model key invalidated successfully"
        : "Model key changed since the call; left as is";
      response.companySecret = companySecret;
    } catch (error) {
      const message = "Unknown error in invalidating model key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.InvalidateModelKey,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Not paged: one row per provider or connection credential, so a company has a handful
  async getCompanySecrets(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompanySecretsDALRequest,
  ) {
    const response: Schemas.CompanySecretsDALResponse = { isSuccess: false };

    try {
      const companySecretsResponse = await tx
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.companyId, params.companyId))
        .orderBy(asc(companySecrets.createdAt), asc(companySecrets.id));

      response.isSuccess = true;
      response.message = "Company secrets fetched successfully";
      response.companySecrets = companySecretsResponse;
    } catch (error) {
      const message = "Unknown error in listing company secrets";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListCompanySecrets,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateCompanySecret(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateCompanySecretDALRequest,
  ) {
    const response: Schemas.CompanySecretDALResponse = { isSuccess: false };
    const { encryptedSecret: _encryptedSecret, iv: _iv, ...metadata } = params;

    try {
      const now = new Date();
      const conditions = [
        eq(companySecrets.publicId, params.publicId),
        eq(companySecrets.companyId, params.companyId),
      ];
      const [companySecretResponse] = await tx
        .update(companySecrets)
        .set({
          // DEV_NOTE: When a param is null, it's ignored. A new value (rotation) overwrites the row.
          encryptedSecret: params.encryptedSecret ? Buffer.from(params.encryptedSecret) : undefined,
          iv: params.iv ? Buffer.from(params.iv) : undefined,
          encryptionKeyVersion: params.encryptionKeyVersion ?? undefined,
          lastFourChars: params.lastFourChars ?? undefined,
          rotatedAt: params.encryptedSecret ? now : undefined,
          expiresAt: params.expiresAt ?? undefined,
          status: params.status ?? undefined,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning();

      if (!companySecretResponse) {
        const message = "Company secret not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateCompanySecret,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company secret updated successfully";
      response.companySecret = companySecretResponse;
    } catch (error) {
      const message = this.uniqueViolationMessage(
        error,
        "Unknown error in updating company secret",
      );
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateCompanySecret,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }
}
