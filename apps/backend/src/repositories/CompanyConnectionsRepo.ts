import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side; never from the client.
// The JWT issuer → connection lookup is cross-company (withPlatform) and arrives with widget auth (M2-1).
export default class CompanyConnectionsRepo {
  private db: NodePgDatabase;
  private dal: CompanyConnectionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new CompanyConnectionsDAL();
  }

  private withStatusLabel(
    companyConnection: Schemas.CompanyConnection,
  ): Schemas.CompanyConnectionWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      ...rest
    } = companyConnection;
    return {
      ...rest,
      companyConnectionStatus: companyConnection.status,
      companyConnectionStatusLabel:
        Schemas.COMPANY_CONNECTION_STATUS_LABEL_MAP[companyConnection.status],
      companyConnectionEnvironment: companyConnection.environment,
      companyConnectionEnvironmentLabel:
        Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[companyConnection.environment],
      companyConnectionAdapterType: companyConnection.adapterType,
      companyConnectionAdapterTypeLabel:
        Schemas.COMPANY_CONNECTION_ADAPTER_TYPE_LABEL_MAP[companyConnection.adapterType],
      companyConnectionCredentialScope: companyConnection.credentialScope,
      companyConnectionCredentialScopeLabel:
        Schemas.COMPANY_CONNECTION_CREDENTIAL_SCOPE_LABEL_MAP[companyConnection.credentialScope],
    };
  }

  private withCompanyConnectionResponse(
    result: Schemas.CompanyConnectionDALResponse,
  ): Schemas.GetCompanyConnectionApiResponse {
    const { companyConnection, ...rest } = result;
    return {
      ...rest,
      companyConnection: companyConnection ? this.withStatusLabel(companyConnection) : undefined,
    };
  }

  async createCompanyConnection(
    params: Schemas.CreateCompanyConnectionApiRequest & { companyId: string },
  ): Promise<Schemas.CreateCompanyConnectionApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companyConnection } = params;
      const result = await this.dal.createCompanyConnection(tx, {
        companyId: params.companyId,
        environment: companyConnection.environment,
        adapterType:
          companyConnection.adapterType ?? Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
        baseUrl: companyConnection.baseUrl,
        authType: companyConnection.authType,
        authConfig: companyConnection.authConfig,
        credentialScope: companyConnection.credentialScope,
        jwtIssuer: companyConnection.jwtIssuer,
        allowedOrigins: companyConnection.allowedOrigins,
        resetOp: companyConnection.resetOp ?? null,
      });
      return this.withCompanyConnectionResponse(result);
    });
  }

  async getCompanyConnectionDetails(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetCompanyConnectionApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getCompanyConnectionDetails(tx, params);
      return this.withCompanyConnectionResponse(result);
    });
  }

  async getCompanyConnections(params: {
    companyId: string;
  }): Promise<Schemas.GetCompanyConnectionsApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companyConnections, ...rest } = await this.dal.getCompanyConnections(tx, params);
      return {
        ...rest,
        companyConnections: companyConnections?.map((companyConnection) =>
          this.withStatusLabel(companyConnection),
        ),
      };
    });
  }

  async updateCompanyConnection(
    params: Schemas.UpdateCompanyConnectionApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.UpdateCompanyConnectionApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { companyConnection } = params;
      const result = await this.dal.updateCompanyConnection(tx, {
        companyId: params.companyId,
        publicId: params.publicId,
        baseUrl: companyConnection.baseUrl ?? null,
        authConfig: companyConnection.authConfig ?? null,
        jwtIssuer: companyConnection.jwtIssuer ?? null,
        allowedOrigins: companyConnection.allowedOrigins ?? null,
        resetOp: companyConnection.resetOp ?? null,
        status: companyConnection.status ?? null,
      });
      return this.withCompanyConnectionResponse(result);
    });
  }
}
