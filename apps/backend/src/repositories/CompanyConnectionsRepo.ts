import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import JwksProvider from "@/providers/jwks";
import { operatorAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side; never from the client.
// The JWT issuer → connection lookup is cross-company (withPlatform) and lives in WidgetAuthRepo.authenticate.
export default class CompanyConnectionsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: CompanyConnectionsDAL;
  private companySecretsDal: CompanySecretsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new CompanyConnectionsDAL();
    this.companySecretsDal = new CompanySecretsDAL();
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
  ): Schemas.GetCompanyConnectionApiResponse & { failure?: Schemas.CompanyConnectionFailureEnum } {
    const { companyConnection, isIssuerTaken, ...rest } = result;
    return {
      ...rest,
      ...(isIssuerTaken ? { failure: Schemas.CompanyConnectionFailureEnum.IssuerTaken } : {}),
      companyConnection: companyConnection ? this.withStatusLabel(companyConnection) : undefined,
    };
  }

  private refuse(message: string) {
    return { isSuccess: false, message, failure: Schemas.CompanyConnectionFailureEnum.Invalid };
  }

  // DEV_NOTE: Operator only (M7-1, CompanyConnectionsRoutes): the connection and its Created audit row (actor Operator,
  // labelled with the environment) in one transaction. The request already checked the auth settings and reset op.
  async createCompanyConnection(
    params: Schemas.CreateCompanyConnectionApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.CreateCompanyConnectionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.CreateCompanyConnectionApiResponse>> => {
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
          openapiUrl: companyConnection.openapiUrl ?? null,
          openapiShaping: companyConnection.openapiShaping ?? null,
          createdBy: params.adminId,
        });
        if (!result.isSuccess || !result.companyConnection) {
          return this.withCompanyConnectionResponse(result);
        }
        const connection = result.companyConnection;

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: operatorAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.CompanyConnection,
          entityAction: Schemas.AuditEntityActionEnum.Created,
          entity: connection,
          label: Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[connection.environment],
        });
        return { ...this.withCompanyConnectionResponse(result), outboxIds: [outboxId] };
      },
    );
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

  // DEV_NOTE: Operator only (M7-1). The row is locked first and the request compared with it: a field that's absent or
  // equal to the stored one is no change, and a save that changes nothing writes and records nothing. One audit row per
  // kind of change (actor Operator): Updated for base URL, auth settings, issuer or reset op, OriginsChanged for the
  // origins (compared as a set, like the Security page's edit), Activated / Disabled for the status.
  async updateCompanyConnection(
    params: Schemas.UpdateCompanyConnectionApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateCompanyConnectionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateCompanyConnectionApiResponse>> => {
        const { companyConnection } = params;
        const found = await this.dal.getCompanyConnectionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.companyConnection) {
          return this.withCompanyConnectionResponse(found);
        }
        const before = found.companyConnection;

        // DEV_NOTE: A new auth_config must fit the stored auth type and credential scope (both fixed at create). A row saved
        // before M3-2 with an auth type that has no AuthStrategy yet can't take any auth_config: it can't serve tool calls
        // either way, so the fix is a new connection with a supported auth type.
        if (companyConnection.authConfig !== undefined) {
          const issue = Schemas.getAuthConfigIssue({
            authType: before.authType,
            credentialScope: before.credentialScope,
            authConfig: companyConnection.authConfig,
          });
          if (issue) return this.refuse(issue);
        }
        // DEV_NOTE: A reset op (M5-2) only on a Staging connection: an eval never resets a production host
        if (
          companyConnection.resetOp !== undefined &&
          companyConnection.resetOp !== null &&
          before.environment !== Schemas.CompanyConnectionEnvironmentIntEnum.Staging
        ) {
          return this.refuse("Only a staging connection has a reset op");
        }

        const isChanged = (next: unknown, stored: unknown) =>
          next !== undefined && Utility.stableStringify(next) !== Utility.stableStringify(stored);
        const isFieldsChanged =
          // DEV_NOTE: A null base URL leaves it as stored (the DAL ignores null), so it is no change
          isChanged(companyConnection.baseUrl ?? undefined, before.baseUrl) ||
          isChanged(companyConnection.authConfig, before.authConfig) ||
          isChanged(companyConnection.jwtIssuer, before.jwtIssuer) ||
          isChanged(companyConnection.resetOp, before.resetOp) ||
          isChanged(companyConnection.openapiUrl, before.openapiUrl) ||
          isChanged(companyConnection.openapiShaping, before.openapiShaping);
        const storedOrigins = new Set(before.allowedOrigins);
        const nextOrigins = companyConnection.allowedOrigins
          ? new Set(companyConnection.allowedOrigins)
          : undefined;
        const isOriginsChanged =
          nextOrigins !== undefined &&
          (nextOrigins.size !== storedOrigins.size ||
            [...nextOrigins].some((origin) => !storedOrigins.has(origin)));
        const isStatusChanged =
          companyConnection.status !== undefined && companyConnection.status !== before.status;
        if (!isFieldsChanged && !isOriginsChanged && !isStatusChanged) {
          return { ...this.withCompanyConnectionResponse(found), outboxIds: [] };
        }

        const result = await this.dal.updateCompanyConnection(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          baseUrl: companyConnection.baseUrl ?? null,
          authConfig: companyConnection.authConfig ?? null,
          jwtIssuer: companyConnection.jwtIssuer ?? null,
          allowedOrigins: isOriginsChanged ? [...(nextOrigins ?? [])] : null,
          status: companyConnection.status ?? null,
          resetOp: companyConnection.resetOp,
          openapiUrl: companyConnection.openapiUrl,
          openapiShaping: companyConnection.openapiShaping,
          updatedBy: params.adminId,
        });
        if (!result.isSuccess || !result.companyConnection) {
          return this.withCompanyConnectionResponse(result);
        }
        const connection = result.companyConnection;

        const actions: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.CompanyConnection>[] =
          [];
        if (isFieldsChanged) actions.push(Schemas.AuditEntityActionEnum.Updated);
        if (isOriginsChanged) actions.push(Schemas.AuditEntityActionEnum.OriginsChanged);
        if (isStatusChanged) {
          actions.push(
            connection.status === Schemas.CompanyConnectionStatusIntEnum.Active
              ? Schemas.AuditEntityActionEnum.Activated
              : Schemas.AuditEntityActionEnum.Disabled,
          );
        }
        const outboxIds: string[] = [];
        for (const entityAction of actions) {
          outboxIds.push(
            await recordAuditOrRollback(tx, {
              companyId: params.companyId,
              actor: operatorAuditActor(params.adminId),
              entityType: Schemas.AuditEntityTypeEnum.CompanyConnection,
              entityAction,
              entity: connection,
              label: Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[connection.environment],
            }),
          );
        }
        return { ...this.withCompanyConnectionResponse(result), outboxIds };
      },
    );
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
      actor: Schemas.AuditActor;
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
          actor: params.actor,
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

  // ─── The test sign-in for the hosted eval runner (M7-9, ADR 0007) ──────────

  // DEV_NOTE: Operator only. Which host and as whom (never a password, API key or admin secret): the stored login is
  // decrypted here, server side, and only kind and hostUser leave. null = the connection has none.
  async getEvalHostLogin(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetEvalHostLoginApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetEvalHostLoginApiResponse> => {
        const connection = await this.dal.getCompanyConnectionDetails(tx, params);
        if (!connection.isSuccess || !connection.companyConnection) {
          return {
            isSuccess: false,
            message: connection.message,
            isNotFound: connection.isNotFound,
          };
        }
        const secret = await this.companySecretsDal.getConnectionEvalHostLogin(tx, {
          companyId: params.companyId,
          connectionId: connection.companyConnection.id,
        });
        if (!secret.isSuccess || !secret.companySecret) {
          return secret.isNotFound
            ? {
                isSuccess: true,
                message: "The connection has no test sign-in",
                evalHostLogin: null,
              }
            : { isSuccess: false, message: secret.message };
        }
        const decrypted = await CompanyKeyProvider.decryptCompanySecret(
          this.env,
          tx,
          secret.companySecret,
        );
        const login =
          decrypted.isSuccess && decrypted.secret !== undefined
            ? Schemas.ZEvalHostLogin.safeParse(Utility.parseJson(decrypted.secret))
            : null;
        if (!login?.success)
          return { isSuccess: false, message: "The stored test sign-in can't be read" };
        return {
          isSuccess: true,
          message: "Test sign-in fetched",
          evalHostLogin: {
            kind: login.data.kind,
            kindLabel: Schemas.EVAL_HOST_LOGIN_KIND_LABEL_MAP[login.data.kind],
            hostUser: login.data.hostUser,
            updatedAt: secret.companySecret.updatedAt.toISOString(),
          },
        };
      },
    );
  }

  // DEV_NOTE: Operator only, a Staging connection only (the DAL checks it too). The whole login is encrypted under the
  // company key and replaces the Active one in place (row locked), or creates it; one TestLoginSet audit row (actor
  // Operator, labelled with the host kind). The login is never logged or returned.
  async setEvalHostLogin(
    params: Schemas.SetEvalHostLoginApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.GetEvalHostLoginApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.GetEvalHostLoginApiResponse>> => {
        const { companyId } = params;
        const login = params.evalHostLogin;
        const connection = await this.dal.getCompanyConnectionDetails(tx, {
          companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!connection.isSuccess || !connection.companyConnection) {
          return {
            isSuccess: false,
            message: connection.message,
            isNotFound: connection.isNotFound,
            outboxIds: [],
          };
        }
        const { companyConnection } = connection;
        if (companyConnection.environment !== Schemas.CompanyConnectionEnvironmentIntEnum.Staging) {
          return {
            ...this.refuse("Only a staging connection takes a test sign-in"),
            outboxIds: [],
          };
        }

        const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, {
          companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          plaintext: JSON.stringify(login),
        });
        if (!encrypted.isSuccess)
          return { isSuccess: false, message: encrypted.message, outboxIds: [] };
        const lastFourChars = login.hostUser.slice(-4);

        const existing = await this.companySecretsDal.getConnectionEvalHostLogin(tx, {
          companyId,
          connectionId: companyConnection.id,
          isForUpdate: true,
        });
        if (!existing.isSuccess && !existing.isNotFound) {
          return { isSuccess: false, message: existing.message, outboxIds: [] };
        }
        const saved = existing.companySecret
          ? await this.companySecretsDal.updateCompanySecret(tx, {
              companyId,
              publicId: existing.companySecret.publicId,
              encryptedSecret: encrypted.encryptedValue.ciphertext,
              iv: encrypted.encryptedValue.iv,
              encryptionKeyVersion: encrypted.encryptionKeyVersion,
              lastFourChars,
              expiresAt: null,
              status: null,
              updatedBy: params.adminId,
            })
          : await this.companySecretsDal.createCompanySecret(tx, {
              companyId,
              type: Schemas.CompanySecretTypeIntEnum.EvalHostLogin,
              provider: null,
              connectionId: companyConnection.id,
              encryptedSecret: encrypted.encryptedValue.ciphertext,
              iv: encrypted.encryptedValue.iv,
              encryptionKeyVersion: encrypted.encryptionKeyVersion,
              lastFourChars,
              expiresAt: null,
              createdBy: params.adminId,
            });
        if (!saved.isSuccess || !saved.companySecret) {
          throw new TenantRollbackError(saved.message ?? "Test sign-in not saved");
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId,
          actor: operatorAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.CompanyConnection,
          entityAction: Schemas.AuditEntityActionEnum.TestLoginSet,
          entity: companyConnection,
          label: Schemas.EVAL_HOST_LOGIN_KIND_LABEL_MAP[login.kind],
        });
        return {
          isSuccess: true,
          message: "Test sign-in saved",
          evalHostLogin: {
            kind: login.kind,
            kindLabel: Schemas.EVAL_HOST_LOGIN_KIND_LABEL_MAP[login.kind],
            hostUser: login.hostUser,
            updatedAt: saved.companySecret.updatedAt.toISOString(),
          },
          outboxIds: [outboxId],
        };
      },
    );
  }

  // DEV_NOTE: Operator only: the Active test sign-in is Revoked (the row stays, its value unusable), with a
  // TestLoginRemoved audit row. None to remove is a no-op success that records nothing.
  async removeEvalHostLogin(params: {
    companyId: string;
    publicId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.GetEvalHostLoginApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.GetEvalHostLoginApiResponse>> => {
        const { companyId } = params;
        const connection = await this.dal.getCompanyConnectionDetails(tx, {
          companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!connection.isSuccess || !connection.companyConnection) {
          return {
            isSuccess: false,
            message: connection.message,
            isNotFound: connection.isNotFound,
            outboxIds: [],
          };
        }
        const { companyConnection } = connection;
        const existing = await this.companySecretsDal.getConnectionEvalHostLogin(tx, {
          companyId,
          connectionId: companyConnection.id,
          isForUpdate: true,
        });
        if (existing.isNotFound) {
          return {
            isSuccess: true,
            message: "The connection has no test sign-in",
            evalHostLogin: null,
            outboxIds: [],
          };
        }
        if (!existing.isSuccess || !existing.companySecret) {
          return { isSuccess: false, message: existing.message, outboxIds: [] };
        }
        const revoked = await this.companySecretsDal.updateCompanySecret(tx, {
          companyId,
          publicId: existing.companySecret.publicId,
          encryptedSecret: null,
          iv: null,
          encryptionKeyVersion: null,
          lastFourChars: null,
          expiresAt: null,
          status: Schemas.CompanySecretStatusIntEnum.Revoked,
          updatedBy: params.adminId,
        });
        if (!revoked.isSuccess)
          throw new TenantRollbackError(revoked.message ?? "Test sign-in not removed");

        const outboxId = await recordAuditOrRollback(tx, {
          companyId,
          actor: operatorAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.CompanyConnection,
          entityAction: Schemas.AuditEntityActionEnum.TestLoginRemoved,
          entity: companyConnection,
          label: Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[companyConnection.environment],
        });
        return {
          isSuccess: true,
          message: "Test sign-in removed",
          evalHostLogin: null,
          outboxIds: [outboxId],
        };
      },
    );
  }
}
