import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, companyConnections } from "@/db/tables";
import { sql } from "drizzle-orm";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: jwt_issuer is unique across companies, and RLS hides other companies' rows, so a clash can't be
// checked up front — the insert or update fails on this index and the DAL names it.
const JWT_ISSUER_INDEX = "UNQ_company_connections_jwt_issuer";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS).
export default class CompanyConnectionsDAL {
  async createCompanyConnection(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateCompanyConnectionDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

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
          action: Schemas.LogAction.CreateCompanyConnection,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [companyConnectionResponse] = await tx
        .insert(companyConnections)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          environment: params.environment,
          adapterType: params.adapterType,
          baseUrl: params.baseUrl,
          authType: params.authType,
          authConfig: params.authConfig,
          credentialScope: params.credentialScope,
          jwtIssuer: params.jwtIssuer,
          allowedOrigins: params.allowedOrigins,
          resetOp: params.resetOp,
          openapiUrl: params.openapiUrl,
          openapiShaping: params.openapiShaping,
          createdBy: params.createdBy,
          updatedBy: params.createdBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Company connection created successfully";
      response.companyConnection = companyConnectionResponse;
    } catch (error) {
      const isIssuerTaken = Utility.isUniqueViolation(error, JWT_ISSUER_INDEX);
      const message = isIssuerTaken
        ? "Issuer already in use"
        : "Unknown error in creating company connection";
      if (isIssuerTaken) response.isIssuerTaken = true;
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateCompanyConnection,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getCompanyConnectionDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompanyConnectionDetailsDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

    try {
      const conditions = [
        params.id !== undefined
          ? eq(companyConnections.id, params.id)
          : eq(companyConnections.publicId, params.publicId),
        eq(companyConnections.companyId, params.companyId),
      ];
      const query = tx
        .select()
        .from(companyConnections)
        .where(and(...conditions))
        .limit(1);
      const [companyConnection] = params.isForUpdate ? await query.for("update") : await query;

      if (!companyConnection) {
        const message = "Company connection not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetCompanyConnectionDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company connection fetched successfully";
      response.companyConnection = companyConnection;
    } catch (error) {
      const message = "Unknown error in fetching company connection";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyConnectionDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The JWT issuer → connection lookup (widget auth). Runs in withPlatform because no company is known
  // yet, so it is the one method here that doesn't filter on companyId. jwt_issuer is unique
  // across companies, so at most one row matches.
  async getCompanyConnectionByIssuer(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindCompanyConnectionByIssuerDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

    try {
      const [companyConnection] = await tx
        .select()
        .from(companyConnections)
        .where(eq(companyConnections.jwtIssuer, params.jwtIssuer))
        .limit(1);

      if (!companyConnection) {
        response.message = "Company connection not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company connection fetched successfully";
      response.companyConnection = companyConnection;
    } catch (error) {
      const message = "Unknown error in fetching company connection by issuer";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyConnectionByIssuer,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getCompanyConnections(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompanyConnectionsDALRequest,
  ) {
    const response: Schemas.CompanyConnectionsDALResponse = { isSuccess: false };

    try {
      const companyConnectionsResponse = await tx
        .select()
        .from(companyConnections)
        .where(eq(companyConnections.companyId, params.companyId));

      response.isSuccess = true;
      response.message = "Company connections fetched successfully";
      response.companyConnections = companyConnectionsResponse;
    } catch (error) {
      const message = "Unknown error in listing company connections";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListCompanyConnections,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: M7-8. Cross-company (withPlatform): the environments the listed companies have an active connection in,
  // one row per company and environment
  async getConnectionEnvironments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetConnectionEnvironmentsDALRequest,
  ) {
    const response: Schemas.ConnectionEnvironmentsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        inArray(companyConnections.companyId, params.companyIds),
        eq(companyConnections.status, Schemas.CompanyConnectionStatusIntEnum.Active),
      ];
      const rows = await tx
        .selectDistinct({
          companyId: companyConnections.companyId,
          environment: companyConnections.environment,
        })
        .from(companyConnections)
        .where(and(...conditions))
        .orderBy(asc(companyConnections.environment));

      response.isSuccess = true;
      response.message = "Connection environments fetched successfully";
      response.environments = rows;
    } catch (error) {
      const message = "Unknown error in listing connection environments";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListConnectionEnvironments,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateCompanyConnection(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateCompanyConnectionDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const conditions = [
        eq(companyConnections.publicId, params.publicId),
        eq(companyConnections.companyId, params.companyId),
      ];
      const [companyConnectionResponse] = await tx
        .update(companyConnections)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          baseUrl: params.baseUrl ?? undefined,
          authConfig: params.authConfig ?? undefined,
          jwtIssuer: params.jwtIssuer ?? undefined,
          allowedOrigins: params.allowedOrigins ?? undefined,
          status: params.status ?? undefined,
          // DEV_NOTE: undefined = unchanged, null = cleared
          resetOp: params.resetOp,
          openapiUrl: params.openapiUrl,
          openapiShaping: params.openapiShaping,
          updatedBy: params.updatedBy,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning();

      if (!companyConnectionResponse) {
        const message = "Company connection not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateCompanyConnection,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company connection updated successfully";
      response.companyConnection = companyConnectionResponse;
    } catch (error) {
      const isIssuerTaken = Utility.isUniqueViolation(error, JWT_ISSUER_INDEX);
      const message = isIssuerTaken
        ? "Issuer already in use"
        : "Unknown error in updating company connection";
      if (isIssuerTaken) response.isIssuerTaken = true;
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateCompanyConnection,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The Security page's Edit (M4-9): the widget's allowed origins only, by the admin. Unknown or another
  // company's connection → isNotFound.
  async updateCompanyConnectionOrigins(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateCompanyConnectionOriginsDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyConnections.publicId, params.publicId),
        eq(companyConnections.companyId, params.companyId),
      ];
      const [companyConnectionResponse] = await tx
        .update(companyConnections)
        .set({
          allowedOrigins: params.allowedOrigins,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!companyConnectionResponse) {
        response.message = "Company connection not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Allowed origins updated successfully";
      response.companyConnection = companyConnectionResponse;
    } catch (error) {
      const message = "Unknown error in updating allowed origins";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateAllowedOrigins,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: ADR 0009. Cross-company, so only inside withPlatform: the connections the hourly sync reads next, never
  // synced first, then the longest ago. An operator's sync of one connection doesn't use this.
  async getToolContractDueConnections(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetToolContractDueConnectionsDALRequest,
  ) {
    const response: Schemas.ToolContractDueConnectionsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyConnections.status, Schemas.CompanyConnectionStatusIntEnum.Active),
        eq(companyConnections.adapterType, Schemas.CompanyConnectionAdapterTypeIntEnum.Rest),
        isNotNull(companyConnections.openapiUrl),
        or(
          isNull(companyConnections.openapiSyncedAt),
          lt(companyConnections.openapiSyncedAt, params.syncedBefore),
        ),
      ];
      const rows = await tx
        .select({
          id: companyConnections.id,
          publicId: companyConnections.publicId,
          companyId: companyConnections.companyId,
          openapiUrl: companyConnections.openapiUrl,
          openapiShaping: companyConnections.openapiShaping,
          openapiSpecHash: companyConnections.openapiSpecHash,
          openapiFailure: companyConnections.openapiFailure,
        })
        .from(companyConnections)
        .where(and(...conditions))
        .orderBy(
          sql`${companyConnections.openapiSyncedAt} asc nulls first`,
          asc(companyConnections.id),
        )
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Connections due for a contract sync fetched successfully";
      response.connections = rows;
    } catch (error) {
      const message = "Unknown error in listing connections due for a contract sync";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListToolContractConnections,
        message,
        error,
        metadata: { limit: params.limit },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: ADR 0009. What a sync found, on the connection: synced_at moves on every sync (it is what rotates the
  // sweep), the spec hash only when the spec was read, the failure is null when the sync was fine.
  async recordToolContractSync(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.RecordToolContractSyncDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const updated = await tx
        .update(companyConnections)
        .set({
          openapiSyncedAt: new Date(),
          openapiFailure: params.openapiFailure,
          openapiSpecHash: params.openapiSpecHash ?? undefined,
        })
        .where(
          and(
            eq(companyConnections.publicId, params.publicId),
            eq(companyConnections.companyId, params.companyId),
          ),
        )
        .returning({ id: companyConnections.id });

      response.isSuccess = updated.length > 0;
      response.message = updated.length > 0 ? "Contract sync recorded" : "Connection not found";
    } catch (error) {
      const message = "Unknown error in recording a contract sync";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.RecordToolContractSync,
        message,
        error,
        metadata: { companyId: params.companyId, publicId: params.publicId },
      });
      response.message = message;
    }

    return response;
  }
}
