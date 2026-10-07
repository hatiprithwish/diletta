import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, companyConnections } from "@/db/tables";
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
        })
        .returning();

      response.isSuccess = true;
      response.message = "Company connection created successfully";
      response.companyConnection = companyConnectionResponse;
    } catch (error) {
      const message = Utility.isUniqueViolation(error, JWT_ISSUER_INDEX)
        ? "Issuer already in use"
        : "Unknown error in creating company connection";
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
    params: Schemas.FindCompanyConnectionDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

    try {
      const [companyConnection] = await tx
        .select()
        .from(companyConnections)
        .where(
          and(
            eq(companyConnections.publicId, params.publicId),
            eq(companyConnections.companyId, params.companyId),
          ),
        )
        .limit(1);

      if (!companyConnection) {
        const message = "Company connection not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetCompanyConnectionDetails,
          message,
          metadata: params,
        });
        response.message = message;
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

  async updateCompanyConnection(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateCompanyConnectionDALRequest,
  ) {
    const response: Schemas.CompanyConnectionDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const [companyConnectionResponse] = await tx
        .update(companyConnections)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          baseUrl: params.baseUrl ?? undefined,
          authConfig: params.authConfig ?? undefined,
          jwtIssuer: params.jwtIssuer ?? undefined,
          allowedOrigins: params.allowedOrigins ?? undefined,
          status: params.status ?? undefined,
          updatedAt: now,
        })
        .where(
          and(
            eq(companyConnections.publicId, params.publicId),
            eq(companyConnections.companyId, params.companyId),
          ),
        )
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
        return response;
      }

      response.isSuccess = true;
      response.message = "Company connection updated successfully";
      response.companyConnection = companyConnectionResponse;
    } catch (error) {
      const message = Utility.isUniqueViolation(error, JWT_ISSUER_INDEX)
        ? "Issuer already in use"
        : "Unknown error in updating company connection";
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
}
