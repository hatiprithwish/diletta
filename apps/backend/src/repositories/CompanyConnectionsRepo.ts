import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import JwksProvider from "@/providers/jwks";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side; never from the client.
// The JWT issuer → connection lookup is cross-company (withPlatform) and lives in WidgetAuthRepo.authenticate.
export default class CompanyConnectionsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: CompanyConnectionsDAL;

  constructor(env: Env) {
    this.env = env;
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
      // DEV_NOTE: A new auth_config must fit the stored auth type and credential scope (both fixed at create). A row saved
      // before M3-2 with an auth type that has no AuthStrategy yet can't take any auth_config: it can't serve tool calls
      // either way, so the fix is a new connection with a supported auth type.
      // DEV_NOTE: A reset op (M5-2) only on a Staging connection: an eval never resets a production host
      const hasResetOp =
        companyConnection.resetOp !== undefined && companyConnection.resetOp !== null;
      if (companyConnection.authConfig !== undefined || hasResetOp) {
        const found = await this.dal.getCompanyConnectionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
        });
        if (!found.isSuccess || !found.companyConnection) {
          return this.withCompanyConnectionResponse(found);
        }
        if (companyConnection.authConfig !== undefined) {
          const issue = Schemas.getAuthConfigIssue({
            authType: found.companyConnection.authType,
            credentialScope: found.companyConnection.credentialScope,
            authConfig: companyConnection.authConfig,
          });
          if (issue) return { isSuccess: false, message: issue };
        }
        if (
          hasResetOp &&
          found.companyConnection.environment !==
            Schemas.CompanyConnectionEnvironmentIntEnum.Staging
        ) {
          return { isSuccess: false, message: "Only a staging connection has a reset op" };
        }
      }
      const result = await this.dal.updateCompanyConnection(tx, {
        companyId: params.companyId,
        publicId: params.publicId,
        baseUrl: companyConnection.baseUrl ?? null,
        authConfig: companyConnection.authConfig ?? null,
        jwtIssuer: companyConnection.jwtIssuer ?? null,
        allowedOrigins: companyConnection.allowedOrigins ?? null,
        status: companyConnection.status ?? null,
        resetOp: companyConnection.resetOp,
      });
      return this.withCompanyConnectionResponse(result);
    });
  }

  // DEV_NOTE: The Security page's view of a connection (M4-9): issuer, origins and when its signing keys were last
  // fetched (the JWKS cache, read outside any transaction); no auth settings or base URL
  private async toSecurityConnection(
    connection: Schemas.CompanyConnection,
  ): Promise<Schemas.SecurityConnection> {
    return {
      publicId: connection.publicId,
      environment: connection.environment,
      environmentLabel: Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[connection.environment],
      status: connection.status,
      statusLabel: Schemas.COMPANY_CONNECTION_STATUS_LABEL_MAP[connection.status],
      jwtIssuer: connection.jwtIssuer,
      allowedOrigins: connection.allowedOrigins,
      signingKeysFetchedAt:
        (await JwksProvider.getCachedFetchedAt(this.env, connection.jwtIssuer))?.toISOString() ??
        null,
    };
  }

  // DEV_NOTE: The company's connections, production first, then staging, oldest first within each: the one order both
  // the Security page and Settings › Connections show
  private async listSortedConnections(
    companyId: string,
  ): Promise<Schemas.ApiResponse & { connections?: Schemas.CompanyConnection[] }> {
    const listed = await withTenant(this.db, companyId, async (tx) => {
      return await this.dal.getCompanyConnections(tx, { companyId });
    });
    if (!listed.isSuccess || !("companyConnections" in listed) || !listed.companyConnections) {
      return { isSuccess: false, message: listed.message };
    }
    return {
      isSuccess: true,
      connections: [...listed.companyConnections].sort(
        (a, b) => a.environment - b.environment || a.createdAt.getTime() - b.createdAt.getTime(),
      ),
    };
  }

  // DEV_NOTE: Identity and origins (the Security page)
  async getSecurityConnections(params: {
    companyId: string;
  }): Promise<Schemas.GetSecurityConnectionsApiResponse> {
    const listed = await this.listSortedConnections(params.companyId);
    if (!listed.isSuccess || !listed.connections)
      return { isSuccess: false, message: listed.message };
    return {
      isSuccess: true,
      message: "Connections fetched successfully",
      connections: await Promise.all(
        listed.connections.map((row) => this.toSecurityConnection(row)),
      ),
    };
  }

  // DEV_NOTE: Settings › Connections (M4-10): the Security view plus the API address and the sign-in method in words
  // (Schemas.companyConnectionSignInLabel). Never auth_config or a credential.
  async getSettingsConnections(params: {
    companyId: string;
  }): Promise<Schemas.GetSettingsConnectionsApiResponse> {
    const listed = await this.listSortedConnections(params.companyId);
    if (!listed.isSuccess || !listed.connections)
      return { isSuccess: false, message: listed.message };
    return {
      isSuccess: true,
      message: "Connections fetched successfully",
      connections: await Promise.all(
        listed.connections.map(async (row) => ({
          ...(await this.toSecurityConnection(row)),
          baseUrl: row.baseUrl,
          signInLabel: Schemas.companyConnectionSignInLabel(row.authType),
        })),
      ),
    };
  }

  // DEV_NOTE: Edit allowed origins: the whole list, replacing the stored one, with its audit row (M4-9) labelled with the
  // environment. The same origins again, in any order (the gate checks membership only), change nothing and record
  // nothing; the row is locked first, so two saves of one new list record one row. The widget gate reads the new list at the next
  // connect (WidgetAuthRepo.authenticate).
  async updateAllowedOrigins(
    params: Schemas.UpdateAllowedOriginsApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateAllowedOriginsApiResponse>> {
    const updated = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.CompanyConnectionDALResponse>> => {
        const before = await this.dal.getCompanyConnectionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!before.isSuccess || !before.companyConnection) return before;
        // DEV_NOTE: The request has no repeats (ZUpdateAllowedOriginsApiRequest), so equal sizes + every one stored = same
        const stored = new Set(before.companyConnection.allowedOrigins);
        const isSame =
          stored.size === params.allowedOrigins.length &&
          params.allowedOrigins.every((origin) => stored.has(origin));
        if (isSame) return { ...before, outboxIds: [] };

        const result = await this.dal.updateCompanyConnectionOrigins(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          allowedOrigins: params.allowedOrigins,
          updatedBy: params.adminId,
        });
        if (!result.isSuccess || !result.companyConnection) return result;
        const connection = result.companyConnection;

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.CompanyConnection,
          entityAction: Schemas.AuditEntityActionEnum.OriginsChanged,
          entity: connection,
          label: Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[connection.environment],
        });
        return { ...result, outboxIds: [outboxId] };
      },
    );
    if (!updated.isSuccess || !("companyConnection" in updated) || !updated.companyConnection) {
      return { isSuccess: false, message: updated.message, isNotFound: updated.isNotFound };
    }
    return {
      isSuccess: true,
      message: "Allowed origins updated successfully",
      connection: await this.toSecurityConnection(updated.companyConnection),
      outboxIds: updated.outboxIds,
    };
  }
}
