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
          .select({ id: companyConnections.id })
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
