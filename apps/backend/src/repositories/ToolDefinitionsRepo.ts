import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

const STORED_OPS_INVALID_MESSAGE = "Stored tool ops are invalid";

// DEV_NOTE: Tool definitions (M3-1): the curated manifest of a company's host API operations, managed by operators
// (/operator/companies/:companyPublicId/tool-definitions). Tenant Repo: one withTenant per call on the company the
// route named. A version's lifecycle mirrors chatbot_configs:
//   create → version 1, Draft (a name already in use is refused: create a new version of it instead)
//   edit → Draft only; ops are replaced as one unit and re-validated with the risk and idempotency mode on the
//     merged row
//   new version → copies a version into a Draft at the name's highest version + 1, at most one Draft per name
//   status → Draft → Active, Active ↔ Disabled; an active or disabled version never changes again (a config pins it)
//   delete → Draft only
// A tool's connection must be able to serve its calls (Active, REST, with a base_url) on create, on a connection
// change and on activation.
// Several versions of one name may be Active at once, on purpose: the published config pins v1 while a draft config
// (and its gate eval) pins v2, and a rollback copy pins v1 again. Activating a version never disables another. The
// runtime loads exactly a config's { name, version } pins (the config spec refuses a name twice), never a tool by
// name or "latest Active".
// Ops are written only through normalizeToolOps (current schema_version) and read only through loadToolOps.
export default class ToolDefinitionsRepo {
  private db: NodePgDatabase;
  private dal: ToolDefinitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ToolDefinitionsDAL();
  }

  private refuse(
    failure: Schemas.ToolDefinitionFailureEnum,
    message: string,
  ): Schemas.ToolDefinitionStateResponse {
    return { isSuccess: false, message, failure };
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
  ): Schemas.ToolDefinitionMutationResponse {
    const { toolDefinition, ...rest } = result;
    if (!toolDefinition) return { ...rest, toolDefinition: undefined };
    const loaded = this.loadRowOps(toolDefinition);
    if (!loaded.ops) return { isSuccess: false, message: STORED_OPS_INVALID_MESSAGE };
    return { ...rest, toolDefinition: this.withStatusLabel(toolDefinition, loaded.ops) };
  }

  // DEV_NOTE: After a write in the same transaction: a written row that can't be answered with rolls the write back
  // (TenantRollbackError), so a 500 never leaves a committed row behind it
  private withWrittenToolResponse(
    result: Schemas.ToolDefinitionDALResponse,
  ): Schemas.ToolDefinitionMutationResponse {
    const response = this.withToolResponse(result);
    if (result.isSuccess && !response.isSuccess) {
      throw new TenantRollbackError(response.message ?? STORED_OPS_INVALID_MESSAGE);
    }
    return response;
  }

  // DEV_NOTE: Client ops at the current schema version, checked against the risk and idempotency mode they will be
  // stored with
  private normalizeOps(
    tool: Pick<Schemas.ToolDefinition, "risk" | "idempotencyMode">,
    ops: unknown,
  ): Schemas.ToolOpsResult {
    const normalized = Schemas.normalizeToolOps(ops);
    if (!normalized.isSuccess || !normalized.ops || normalized.schemaVersion === undefined) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ToolDefinitionFailureEnum.InvalidOps,
          normalized.message ?? "Invalid tool ops",
        ),
      };
    }
    // DEV_NOTE: The runtime checks the model's args against input_schema (M3-4), so a schema it can't check is refused
    const issue = Schemas.getToolOpsIssue(tool.risk, tool.idempotencyMode, normalized.ops);
    if (issue) {
      return {
        isSuccess: false,
        response: this.refuse(Schemas.ToolDefinitionFailureEnum.InvalidOps, issue),
      };
    }
    return { isSuccess: true, ops: normalized.ops, schemaVersion: normalized.schemaVersion };
  }

  // DEV_NOTE: The stored ops (loaded) must fit a risk and idempotency mode: activation, and an edit that changes either
  // without new ops
  private checkStoredOps(
    row: Schemas.ToolDefinitionRow,
    tool: Pick<Schemas.ToolDefinition, "risk" | "idempotencyMode">,
  ): Schemas.ToolDefinitionStateResponse | null {
    const loaded = this.loadRowOps(row);
    if (!loaded.ops) return { isSuccess: false, message: STORED_OPS_INVALID_MESSAGE };
    const issue = Schemas.getToolOpsIssue(tool.risk, tool.idempotencyMode, loaded.ops);
    return issue ? this.refuse(Schemas.ToolDefinitionFailureEnum.InvalidOps, issue) : null;
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

  // DEV_NOTE: The connection must be the company's and able to serve tool calls: Active, a REST connection, with a
  // base_url (every op path is relative to it), and auth settings the adapter accepts (getAuthConfigIssue)
  private async resolveConnection(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; connectionPublicId: string },
  ): Promise<Schemas.ToolConnectionResult> {
    const found = await this.dal.getToolConnection(tx, params);
    if (!found.isSuccess) {
      return { isSuccess: false, response: { isSuccess: false, message: found.message } };
    }
    const connection = found.connection;
    if (!connection) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ToolDefinitionFailureEnum.ConnectionNotFound,
          "Connection not found",
        ),
      };
    }
    if (
      connection.status !== Schemas.CompanyConnectionStatusIntEnum.Active ||
      connection.adapterType !== Schemas.CompanyConnectionAdapterTypeIntEnum.Rest ||
      !connection.baseUrl
    ) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable,
          "Connection can't serve tool calls: it must be an active REST connection with a base URL",
        ),
      };
    }
    // DEV_NOTE: The adapter refuses a connection whose auth type has no AuthStrategy or whose auth_config doesn't fit it
    // (a row saved before M3-2 may hold either), so such a connection can't serve tool calls either
    const authIssue = Schemas.getAuthConfigIssue(connection);
    if (authIssue) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable,
          `Connection can't serve tool calls: ${authIssue}`,
        ),
      };
    }
    return { isSuccess: true, connectionId: connection.id };
  }

  // DEV_NOTE: The merged row of a Draft edit: new ops are normalised against the merged risk and idempotency mode; a
  // change of either alone must still fit the stored ops (a write tool needs its readback op, an Emulated one reads no
  // {result.*}). Returns the op columns to write (null = unchanged).
  private checkDraftEdit(
    row: Schemas.ToolDefinitionRow,
    body: Schemas.UpdateToolDefinitionApiRequest["toolDefinition"],
  ):
    | { isSuccess: true; opsColumns: Schemas.ToolOpsColumns | null }
    | { isSuccess: false; response: Schemas.ToolDefinitionStateResponse } {
    const tool = {
      risk: body.risk ?? row.risk,
      idempotencyMode: body.idempotencyMode ?? row.idempotencyMode,
    };
    if (body.ops) {
      const ops = this.normalizeOps(tool, body.ops);
      if (!ops.isSuccess) return ops;
      return { isSuccess: true, opsColumns: this.toOpsColumns(ops.ops, ops.schemaVersion) };
    }
    if (body.risk !== undefined || body.idempotencyMode !== undefined) {
      const refused = this.checkStoredOps(row, tool);
      if (refused) return { isSuccess: false, response: refused };
    }
    return { isSuccess: true, opsColumns: null };
  }

  async createToolDefinition(
    params: Schemas.CreateToolDefinitionApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.CreateToolDefinitionApiResponse> {
    const body = params.toolDefinition;
    const ops = this.normalizeOps(body, body.ops);
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
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.NameTaken,
            "A tool with this name already exists; create a new version of it",
          );
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
        return this.withWrittenToolResponse(created);
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
          if (!loaded.ops) return { isSuccess: false, message: STORED_OPS_INVALID_MESSAGE };
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
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.NotDraft,
            "Only a draft version can be edited; create a new version",
          );
        }

        const body = params.toolDefinition;
        const edit = this.checkDraftEdit(row, body);
        if (!edit.isSuccess) return edit.response;

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
          ops: edit.opsColumns,
          updatedBy: params.adminId,
        });
        return this.withWrittenToolResponse(updated);
      },
    );
  }

  // DEV_NOTE: Copies a version (any status) into a new Draft at the name's highest version + 1, re-normalised at the
  // current ops schema version, so an old version's ops are upgraded in the copy and never in place. The connection is
  // copied as it is; activation checks it can still serve calls.
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
        if (!loaded.ops) return { isSuccess: false, message: STORED_OPS_INVALID_MESSAGE };
        const ops = this.normalizeOps(source, loaded.ops);
        if (!ops.isSuccess) return ops.response;

        const nameParams = { companyId: params.companyId, name: source.name };
        const locked = await this.dal.lockToolDefinitionName(tx, nameParams);
        if (!locked.isSuccess) return locked;
        const nameState = await this.dal.getToolDefinitionNameState(tx, nameParams);
        if (!nameState.isSuccess) return { isSuccess: false, message: nameState.message };
        if (nameState.hasDraft) {
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.DraftExists,
            "This tool already has a draft version; edit that one",
          );
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
        return this.withWrittenToolResponse(created);
      },
    );
  }

  // DEV_NOTE: Activating re-checks what a runtime call will need: the ops load at the current schema version and fit
  // the risk and idempotency mode, and the connection still exists and can serve calls (Active, REST, base_url). Setting the status a
  // version already has is a no-op success.
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
          const from = Schemas.TOOL_DEFINITION_STATUS_LABEL_MAP[row.status].toLowerCase();
          const to = Schemas.TOOL_DEFINITION_STATUS_LABEL_MAP[params.status].toLowerCase();
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.InvalidTransition,
            `A ${from} version can't be set to ${to}`,
          );
        }

        if (params.status === Schemas.ToolDefinitionStatusIntEnum.Active) {
          const refused = this.checkStoredOps(row, row);
          if (refused) return refused;
          if (row.connectionPublicId === null) {
            return this.refuse(
              Schemas.ToolDefinitionFailureEnum.ConnectionNotFound,
              "Connection not found",
            );
          }
          const connection = await this.resolveConnection(tx, {
            companyId: params.companyId,
            connectionPublicId: row.connectionPublicId,
          });
          if (!connection.isSuccess) return connection.response;
        }

        const updated = await this.dal.setToolDefinitionStatus(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          status: params.status,
          updatedBy: params.adminId,
        });
        return this.withWrittenToolResponse(updated);
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
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.NotDraft,
            "Only a draft version can be deleted; disable it instead",
          );
        }
        return await this.dal.deleteToolDefinitionDraft(tx, params);
      },
    );
  }
}
