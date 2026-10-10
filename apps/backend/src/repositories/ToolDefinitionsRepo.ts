import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

type ConnectionResult =
  | { isSuccess: true; connectionId: string }
  | { isSuccess: false; response: Schemas.ToolDefinitionStateResponse };

type OpsResult =
  | { isSuccess: true; ops: Schemas.ToolOps; schemaVersion: number }
  | { isSuccess: false; response: Schemas.ToolDefinitionStateResponse };

// DEV_NOTE: Tool definitions (M3-1): the curated manifest of a company's host API operations, managed by operators
// (/operator/companies/:companyPublicId/tool-definitions). Tenant Repo: one withTenant per call on the company the
// route named. A version's lifecycle mirrors chatbot_configs:
//   create → version 1, Draft (a name already in use gets a new version instead)
//   edit → Draft only; ops are replaced as one unit and re-validated with the risk on the merged row
//   new version → copies a version into a Draft at the name's highest version + 1, at most one Draft per name
//   status → Draft → Active, Active ↔ Disabled; an active or disabled version never changes again (a config pins it)
//   delete → Draft only
// Ops are written only through normalizeToolOps (current schema_version) and read only through loadToolOps.
export default class ToolDefinitionsRepo {
  private db: NodePgDatabase;
  private dal: ToolDefinitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ToolDefinitionsDAL();
  }

  // DEV_NOTE: Every stored row was written through normalizeToolOps, so a row whose ops don't load is corrupt or from
  // a version this code no longer knows: logged, and the call fails (500) rather than answering with unchecked ops.
  private loadRowOps(row: Schemas.ToolDefinitionRow): Schemas.LoadToolOpsResponse {
    const loaded = Schemas.loadToolOps({
      schemaVersion: row.schemaVersion,
      ops: {
        inputSchema: row.inputSchema,
        callOp: row.callOp,
        readbackOp: row.readbackOp,
        inverseOp: row.inverseOp,
      },
    });
    if (!loaded.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.LoadToolOps,
        message: "Stored tool ops don't load",
        metadata: {
          publicId: row.publicId,
          schemaVersion: row.schemaVersion,
          reason: loaded.message,
        },
      });
    }
    return loaded;
  }

  private withStatusLabel(
    row: Schemas.ToolDefinitionRow,
    ops: Schemas.ToolOps,
  ): Schemas.ToolDefinitionWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      connectionId: _connectionId,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      inputSchema: _inputSchema,
      callOp: _callOp,
      readbackOp: _readbackOp,
      inverseOp: _inverseOp,
      ...rest
    } = row;
    return {
      ...rest,
      ops,
      toolDefinitionStatus: row.status,
      toolDefinitionStatusLabel: Schemas.TOOL_DEFINITION_STATUS_LABEL_MAP[row.status],
      riskLabel: Schemas.TOOL_DEFINITION_RISK_LABEL_MAP[row.risk],
      idempotencyModeLabel: Schemas.TOOL_DEFINITION_IDEMPOTENCY_MODE_LABEL_MAP[row.idempotencyMode],
      approvalLabel: Schemas.TOOL_DEFINITION_APPROVAL_LABEL_MAP[row.approval],
      sourceLabel: Schemas.TOOL_DEFINITION_SOURCE_LABEL_MAP[row.source],
    };
  }

  private withToolResponse(
    result: Schemas.ToolDefinitionDALResponse,
  ): Schemas.GetToolDefinitionApiResponse {
    const { toolDefinition, ...rest } = result;
    if (!toolDefinition) return { ...rest, toolDefinition: undefined };
    const loaded = this.loadRowOps(toolDefinition);
    if (!loaded.ops) return { isSuccess: false, message: "Stored tool ops are invalid" };
    return { ...rest, toolDefinition: this.withStatusLabel(toolDefinition, loaded.ops) };
  }

  // DEV_NOTE: Client ops at the current schema version, checked against the risk they will be stored with
  private normalizeOps(risk: Schemas.ToolDefinitionRiskIntEnum, ops: unknown): OpsResult {
    const normalized = Schemas.normalizeToolOps(ops);
    if (!normalized.isSuccess || !normalized.ops || normalized.schemaVersion === undefined) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: normalized.message,
          failure: Schemas.ToolDefinitionFailureEnum.InvalidOps,
        },
      };
    }
    const issue = Schemas.getToolRiskOpsIssue(risk, normalized.ops);
    if (issue) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: issue,
          failure: Schemas.ToolDefinitionFailureEnum.InvalidOps,
        },
      };
    }
    return { isSuccess: true, ops: normalized.ops, schemaVersion: normalized.schemaVersion };
  }

  private toOpsColumns(ops: Schemas.ToolOps, schemaVersion: number): Schemas.ToolOpsColumns {
    return {
      schemaVersion,
      inputSchema: ops.inputSchema,
      callOp: ops.callOp,
      readbackOp: ops.readbackOp,
      inverseOp: ops.inverseOp,
    };
  }

  private async resolveConnection(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; connectionPublicId: string },
  ): Promise<ConnectionResult> {
    const found = await this.dal.getToolConnection(tx, params);
    if (!found.isSuccess) {
      return { isSuccess: false, response: { isSuccess: false, message: found.message } };
    }
    if (!found.connectionId) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: "Connection not found",
          failure: Schemas.ToolDefinitionFailureEnum.ConnectionNotFound,
        },
      };
    }
    return { isSuccess: true, connectionId: found.connectionId };
  }

  async createToolDefinition(
    params: Schemas.CreateToolDefinitionApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.CreateToolDefinitionApiResponse> {
    const body = params.toolDefinition;
    const ops = this.normalizeOps(body.risk, body.ops);
    if (!ops.isSuccess) return ops.response;

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.CreateToolDefinitionApiResponse> => {
        const connection = await this.resolveConnection(tx, {
          companyId: params.companyId,
          connectionPublicId: body.connectionPublicId,
        });
        if (!connection.isSuccess) return connection.response;

        const nameParams = { companyId: params.companyId, name: body.name };
        const locked = await this.dal.lockToolDefinitionName(tx, nameParams);
        if (!locked.isSuccess) return locked;
        const nameState = await this.dal.getToolDefinitionNameState(tx, nameParams);
        if (!nameState.isSuccess) return { isSuccess: false, message: nameState.message };
        if ((nameState.latestVersion ?? 0) > 0) {
          return {
            isSuccess: false,
            message: "A tool with this name already exists; create a new version of it",
            failure: Schemas.ToolDefinitionFailureEnum.NameTaken,
          };
        }

        const created = await this.dal.createToolDefinition(tx, {
          companyId: params.companyId,
          connectionId: connection.connectionId,
          name: body.name,
          version: 1,
          description: body.description,
          risk: body.risk,
          ...this.toOpsColumns(ops.ops, ops.schemaVersion),
          idempotencyMode: body.idempotencyMode,
          approval: body.approval,
          source: body.source,
          createdBy: params.adminId,
        });
        return this.withToolResponse(created);
      },
    );
  }

  async getToolDefinitionDetails(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetToolDefinitionApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getToolDefinitionDetails(tx, { ...params, isForUpdate: false });
      return this.withToolResponse(result);
    });
  }

  async getToolDefinitions(
    params: Schemas.GetToolDefinitionsApiRequest & { companyId: string },
  ): Promise<Schemas.GetToolDefinitionsApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetToolDefinitionsApiResponse> => {
        const { toolDefinitions, ...rest } = await this.dal.getToolDefinitions(tx, {
          companyId: params.companyId,
          name: params.name ?? null,
          status: params.status ?? null,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.ToolDefinitionSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!toolDefinitions) return rest;

        const mapped: Schemas.ToolDefinitionWithStatus[] = [];
        for (const row of toolDefinitions) {
          const loaded = this.loadRowOps(row);
          if (!loaded.ops) return { isSuccess: false, message: "Stored tool ops are invalid" };
          mapped.push(this.withStatusLabel(row, loaded.ops));
        }
        return { ...rest, toolDefinitions: mapped };
      },
    );
  }

  async getToolDefinitionsCount(
    params: Schemas.GetToolDefinitionsCountApiRequest & { companyId: string },
  ): Promise<Schemas.GetToolDefinitionsCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.getToolDefinitionsCount(tx, {
        companyId: params.companyId,
        name: params.name ?? null,
        status: params.status ?? null,
      });
    });
  }

  async updateToolDefinition(
    params: Schemas.UpdateToolDefinitionApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.UpdateToolDefinitionApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.UpdateToolDefinitionApiResponse> => {
        const found = await this.dal.getToolDefinitionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.toolDefinition) return this.withToolResponse(found);
        const row = found.toolDefinition;
        if (row.status !== Schemas.ToolDefinitionStatusIntEnum.Draft) {
          return {
            isSuccess: false,
            message: "Only a draft version can be edited; create a new version",
            failure: Schemas.ToolDefinitionFailureEnum.NotDraft,
          };
        }

        const body = params.toolDefinition;
        const risk = body.risk ?? row.risk;
        let opsColumns: Schemas.ToolOpsColumns | null = null;
        if (body.ops) {
          const ops = this.normalizeOps(risk, body.ops);
          if (!ops.isSuccess) return ops.response;
          opsColumns = this.toOpsColumns(ops.ops, ops.schemaVersion);
        } else if (body.risk !== undefined) {
          // DEV_NOTE: A risk change alone must still fit the stored ops (a write tool needs its readback op)
          const loaded = this.loadRowOps(row);
          if (!loaded.ops) return { isSuccess: false, message: "Stored tool ops are invalid" };
          const issue = Schemas.getToolRiskOpsIssue(risk, loaded.ops);
          if (issue) {
            return {
              isSuccess: false,
              message: issue,
              failure: Schemas.ToolDefinitionFailureEnum.InvalidOps,
            };
          }
        }

        let connectionId: string | null = null;
        if (body.connectionPublicId !== undefined) {
          const connection = await this.resolveConnection(tx, {
            companyId: params.companyId,
            connectionPublicId: body.connectionPublicId,
          });
          if (!connection.isSuccess) return connection.response;
          connectionId = connection.connectionId;
        }

        const updated = await this.dal.updateToolDefinitionDraft(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          connectionId,
          description: body.description ?? null,
          risk: body.risk ?? null,
          idempotencyMode: body.idempotencyMode ?? null,
          approval: body.approval ?? null,
          source: body.source ?? null,
          ops: opsColumns,
          updatedBy: params.adminId,
        });
        return this.withToolResponse(updated);
      },
    );
  }

  // DEV_NOTE: Copies a version (any status) into a new Draft at the name's highest version + 1, re-normalised at the
  // current ops schema version, so an old version's ops are upgraded in the copy and never in place
  async createToolDefinitionVersion(params: {
    companyId: string;
    publicId: string;
    adminId: string;
  }): Promise<Schemas.CreateToolDefinitionVersionApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.CreateToolDefinitionVersionApiResponse> => {
        const found = await this.dal.getToolDefinitionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: false,
        });
        if (!found.isSuccess || !found.toolDefinition) return this.withToolResponse(found);
        const source = found.toolDefinition;

        const loaded = this.loadRowOps(source);
        if (!loaded.ops) return { isSuccess: false, message: "Stored tool ops are invalid" };
        const ops = this.normalizeOps(source.risk, loaded.ops);
        if (!ops.isSuccess) return ops.response;

        const nameParams = { companyId: params.companyId, name: source.name };
        const locked = await this.dal.lockToolDefinitionName(tx, nameParams);
        if (!locked.isSuccess) return locked;
        const nameState = await this.dal.getToolDefinitionNameState(tx, nameParams);
        if (!nameState.isSuccess) return { isSuccess: false, message: nameState.message };
        if (nameState.hasDraft) {
          return {
            isSuccess: false,
            message: "This tool already has a draft version; edit that one",
            failure: Schemas.ToolDefinitionFailureEnum.DraftExists,
          };
        }

        const created = await this.dal.createToolDefinition(tx, {
          companyId: params.companyId,
          connectionId: source.connectionId,
          name: source.name,
          version: (nameState.latestVersion ?? 0) + 1,
          description: source.description,
          risk: source.risk,
          ...this.toOpsColumns(ops.ops, ops.schemaVersion),
          idempotencyMode: source.idempotencyMode,
          approval: source.approval,
          source: source.source,
          createdBy: params.adminId,
        });
        return this.withToolResponse(created);
      },
    );
  }

  // DEV_NOTE: Activating re-checks what a runtime call will need: the ops load at the current schema version and fit
  // the risk, and the connection still exists. Setting the status a version already has is a no-op success.
  async setToolDefinitionStatus(
    params: Schemas.SetToolDefinitionStatusApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.SetToolDefinitionStatusApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.SetToolDefinitionStatusApiResponse> => {
        const found = await this.dal.getToolDefinitionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.toolDefinition) return this.withToolResponse(found);
        const row = found.toolDefinition;
        if (row.status === params.status) return this.withToolResponse(found);

        const isAllowed =
          params.status === Schemas.ToolDefinitionStatusIntEnum.Active ||
          row.status === Schemas.ToolDefinitionStatusIntEnum.Active;
        if (!isAllowed) {
          return {
            isSuccess: false,
            message: `A ${Schemas.TOOL_DEFINITION_STATUS_LABEL_MAP[row.status].toLowerCase()} version can't be set to ${Schemas.TOOL_DEFINITION_STATUS_LABEL_MAP[params.status].toLowerCase()}`,
            failure: Schemas.ToolDefinitionFailureEnum.InvalidTransition,
          };
        }

        if (params.status === Schemas.ToolDefinitionStatusIntEnum.Active) {
          const loaded = this.loadRowOps(row);
          const issue = loaded.ops
            ? Schemas.getToolRiskOpsIssue(row.risk, loaded.ops)
            : "Stored tool ops are invalid";
          if (issue) {
            return {
              isSuccess: false,
              message: issue,
              failure: Schemas.ToolDefinitionFailureEnum.InvalidOps,
            };
          }
          if (row.connectionPublicId === null) {
            return {
              isSuccess: false,
              message: "Connection not found",
              failure: Schemas.ToolDefinitionFailureEnum.ConnectionNotFound,
            };
          }
        }

        const updated = await this.dal.setToolDefinitionStatus(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          status: params.status,
          updatedBy: params.adminId,
        });
        return this.withToolResponse(updated);
      },
    );
  }

  async deleteToolDefinition(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.DeleteToolDefinitionApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.DeleteToolDefinitionApiResponse> => {
        const found = await this.dal.getToolDefinitionDetails(tx, { ...params, isForUpdate: true });
        if (!found.isSuccess || !found.toolDefinition) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.toolDefinition.status !== Schemas.ToolDefinitionStatusIntEnum.Draft) {
          return {
            isSuccess: false,
            message: "Only a draft version can be deleted; disable it instead",
            failure: Schemas.ToolDefinitionFailureEnum.NotDraft,
          };
        }
        return await this.dal.deleteToolDefinitionDraft(tx, params);
      },
    );
  }
}
