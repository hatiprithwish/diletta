import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import HostToolCallProvider from "@/providers/hostToolCall";
import AppLogger from "@/providers/logger";
import ToolContractProvider from "@/providers/toolContract";
import {
  operatorAuditActor,
  recordAuditOrRollback,
  recordAuditsOrRollback,
} from "@/repositories/audit";
import Utility from "@/utils/Utility";
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
// Every write records its audit row (M4-9) with actor Operator (these routes are operator-only), the tool's name and
// version, in its own transaction; the outbox ids go back to the route to relay.
export default class ToolDefinitionsRepo {
  private db: NodePgDatabase;
  private dal: ToolDefinitionsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ToolDefinitionsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
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

  // DEV_NOTE: The operator's audit row in the write's transaction; a failure rolls the write back
  private async audit(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; adminId: string },
    row: Schemas.ToolDefinitionRow,
    entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.ToolDefinition>,
  ): Promise<string> {
    return await recordAuditOrRollback(tx, {
      companyId: params.companyId,
      actor: operatorAuditActor(params.adminId),
      entityType: Schemas.AuditEntityTypeEnum.ToolDefinition,
      entityAction,
      entity: row,
      entityVersion: row.version,
      label: row.name,
    });
  }

  // DEV_NOTE: Whether a draft edit changed what the tool is (connection, description, risk, modes, source, ops), so a
  // save that changes nothing records no audit row
  private isDraftChanged(
    before: Schemas.ToolDefinitionRow,
    after: Schemas.ToolDefinitionRow,
  ): boolean {
    const content = (row: Schemas.ToolDefinitionRow) =>
      Utility.stableStringify({
        connectionId: row.connectionId,
        description: row.description,
        risk: row.risk,
        idempotencyMode: row.idempotencyMode,
        approval: row.approval,
        source: row.source,
        schemaVersion: row.schemaVersion,
        inputSchema: row.inputSchema,
        callOp: row.callOp,
        readbackOp: row.readbackOp,
        inverseOp: row.inverseOp,
      });
    return content(before) !== content(after);
  }

  // DEV_NOTE: A written row's answer (withWrittenToolResponse) with its audit row
  private async withAuditedToolResponse(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; adminId: string },
    result: Schemas.ToolDefinitionDALResponse,
    entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.ToolDefinition>,
  ): Promise<Schemas.WithOutboxIds<Schemas.ToolDefinitionMutationResponse>> {
    const response = this.withWrittenToolResponse(result);
    if (!response.isSuccess || !result.toolDefinition) return response;
    const outboxId = await this.audit(tx, params, result.toolDefinition, entityAction);
    return { ...response, outboxIds: [outboxId] };
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

  // DEV_NOTE: The connection's spec URL and shaping (ADR 0009) in a read of their own, so the spec is fetched outside any
  // transaction. The connection is checked again where the tools are written.
  private async readContractSource(params: {
    companyId: string;
    connectionPublicId: string;
  }): Promise<
    | { isSuccess: true; openapiUrl: string; openapiShaping: unknown }
    | { isSuccess: false; response: Schemas.ToolDefinitionStateResponse }
  > {
    const read = await withTenant(this.db, params.companyId, async (tx) => {
      const found = await this.dal.getToolConnection(tx, params);
      if (!found.isSuccess) {
        return {
          isSuccess: false as const,
          response: { isSuccess: false, message: found.message },
        };
      }
      if (!found.connection) {
        return {
          isSuccess: false as const,
          response: this.refuse(
            Schemas.ToolDefinitionFailureEnum.ConnectionNotFound,
            "Connection not found",
          ),
        };
      }
      if (!found.connection.openapiUrl) {
        return {
          isSuccess: false as const,
          response: this.refuse(
            Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable,
            "Set the connection's OpenAPI spec URL first: a tool set takes its schemas from the app's spec",
          ),
        };
      }
      return {
        isSuccess: true as const,
        openapiUrl: found.connection.openapiUrl,
        openapiShaping: found.connection.openapiShaping,
      };
    });
    // DEV_NOTE: withTenant answers a failed transaction as a plain failure
    if ("openapiUrl" in read && read.isSuccess) return read;
    if ("response" in read && read.response) return { isSuccess: false, response: read.response };
    return { isSuccess: false, response: { isSuccess: false, message: read.message } };
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
  ): Promise<Schemas.WithOutboxIds<Schemas.CreateToolDefinitionApiResponse>> {
    const body = params.toolDefinition;
    const ops = this.normalizeOps(body, body.ops);
    if (!ops.isSuccess) return ops.response;

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.CreateToolDefinitionApiResponse>> => {
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
        return await this.withAuditedToolResponse(
          tx,
          params,
          created,
          Schemas.AuditEntityActionEnum.Created,
        );
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
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateToolDefinitionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateToolDefinitionApiResponse>> => {
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
        if (updated.toolDefinition && !this.isDraftChanged(row, updated.toolDefinition)) {
          return this.withWrittenToolResponse(updated);
        }
        return await this.withAuditedToolResponse(
          tx,
          params,
          updated,
          Schemas.AuditEntityActionEnum.Updated,
        );
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
  }): Promise<Schemas.WithOutboxIds<Schemas.CreateToolDefinitionVersionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (
        tx,
      ): Promise<Schemas.WithOutboxIds<Schemas.CreateToolDefinitionVersionApiResponse>> => {
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
        return await this.withAuditedToolResponse(
          tx,
          params,
          created,
          Schemas.AuditEntityActionEnum.VersionCreated,
        );
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
  ): Promise<Schemas.WithOutboxIds<Schemas.SetToolDefinitionStatusApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.SetToolDefinitionStatusApiResponse>> => {
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

        // DEV_NOTE: M4-10: a version a Published chatbot config pins stays Active until no Published config pins it (the
        // publish reads its pins FOR SHARE, so the two can't cross). Each Published body is read through the config spec
        // (readConfigBody, then its publish needs' pins), never by its stored shape, so a body at a later schema version
        // still guards; one that can't be read refuses the disable (it may pin this version).
        if (params.status === Schemas.ToolDefinitionStatusIntEnum.Disabled) {
          const published = await this.chatbotConfigsDal.getPublishedChatbotConfigBodies(tx, {
            companyId: params.companyId,
          });
          if (!published.isSuccess || !published.configs) {
            return { isSuccess: false, message: published.message };
          }
          const isPinned = published.configs.some((config) => {
            const read = Schemas.readConfigBody({
              schemaVersion: config.schemaVersion,
              body: config.body,
            });
            if (!read.isSuccess || !read.body) return true;
            return Schemas.getChatbotConfigPublishNeeds(read.body).pins.some(
              (pin) => pin.name === row.name && pin.version === row.version,
            );
          });
          if (isPinned) {
            return this.refuse(
              Schemas.ToolDefinitionFailureEnum.PinnedByPublishedConfig,
              "A published chatbot version uses this tool version; publish one without it first",
            );
          }
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
        return await this.withAuditedToolResponse(
          tx,
          params,
          updated,
          params.status === Schemas.ToolDefinitionStatusIntEnum.Active
            ? Schemas.AuditEntityActionEnum.Activated
            : Schemas.AuditEntityActionEnum.Disabled,
        );
      },
    );
  }

  // DEV_NOTE: M7-8. Loads a tool set (Schemas.TOOL_SETS) onto one of the company's connections in one transaction, the
  // way the eregister:tools script does, but through the DAL and audited as the operator. Every name is locked and
  // read first (one statement each); a set tool that doesn't fit its own risk, or any name with a Draft (an operator
  // is editing it), refuses the whole load before anything is written. Then each tool ends Active at its newest
  // version: unchanged, made Active again, or a new version (Created / VersionCreated, then Activated audit rows).
  // Older Active versions stay Active, so a bot version pinned to one keeps it. The writes and audit rows go in
  // batches (a few statements for the whole set, not a few per tool); one that fails rolls everything back.
  async loadToolSet(
    params: Schemas.LoadToolSetApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.LoadToolSetApiResponse>> {
    const planned: {
      tool: Schemas.ToolDefinitionSeed;
      ops: Schemas.ToolOps;
      schemaVersion: number;
      operationId: string;
      contractHash: string;
    }[] = [];
    const drafts: {
      tool: Schemas.ToolDefinitionSeed;
      ops: Schemas.ToolOps;
    }[] = [];
    for (const tool of Schemas.TOOL_SETS[params.toolSet]) {
      const ops = this.normalizeOps(tool, tool.ops);
      if (!ops.isSuccess) {
        return this.refuse(
          Schemas.ToolDefinitionFailureEnum.InvalidOps,
          `${tool.name}: ${ops.response.message ?? "Invalid tool ops"}`,
        );
      }
      drafts.push({ tool, ops: ops.ops });
    }

    // DEV_NOTE: A tool set is bindings; each body field's schema comes from the connection's OpenAPI spec (ADR 0009),
    // read before the transaction opens (a slow host never holds one). Without a spec URL nothing is stored: a tool
    // with an empty schema would let the model send anything.
    const source = await this.readContractSource({
      companyId: params.companyId,
      connectionPublicId: params.connectionPublicId,
    });
    if (!source.isSuccess) return source.response;
    const fetched = await HostToolCallProvider.getSpec({ url: source.openapiUrl });
    if (!fetched.isSuccess) {
      return this.refuse(
        Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable,
        `Couldn't read the connection's spec: ${fetched.message}`,
      );
    }
    const spec = Schemas.parseOpenApiSpec(fetched.body);
    if (!spec.isSuccess) {
      return this.refuse(Schemas.ToolDefinitionFailureEnum.InvalidOps, spec.message);
    }
    const derived = await ToolContractProvider.derive({
      spec: spec.spec,
      shaping: ToolContractProvider.shapingOf(source.openapiShaping),
      tools: drafts.map(({ tool, ops }) => ({
        name: tool.name,
        risk: tool.risk,
        ops,
        operationId: null,
      })),
    });
    const failed = derived.filter((result) => !result.isSuccess).map((result) => result.message);
    if (failed.length > 0) {
      return this.refuse(
        Schemas.ToolDefinitionFailureEnum.InvalidOps,
        `The spec doesn't fit these tools: ${failed.slice(0, 5).join("; ")}${failed.length > 5 ? ` (and ${failed.length - 5} more)` : ""}`,
      );
    }
    const unmatched: string[] = [];
    for (const [index, { tool, ops }] of drafts.entries()) {
      const result = derived[index];
      if (!result?.isSuccess) continue;
      const withSchema = this.normalizeOps(tool, { ...ops, inputSchema: result.inputSchema });
      if (!withSchema.isSuccess) {
        return this.refuse(
          Schemas.ToolDefinitionFailureEnum.InvalidOps,
          `${tool.name}: ${withSchema.response.message ?? "Invalid tool ops"}`,
        );
      }
      if (result.missingFields.length > 0) {
        unmatched.push(`${tool.name} (${result.missingFields.join(", ")})`);
      }
      planned.push({
        tool,
        ops: withSchema.ops,
        schemaVersion: withSchema.schemaVersion,
        operationId: result.operationId,
        contractHash: result.contractHash,
      });
    }
    if (unmatched.length > 0) {
      AppLogger.warn({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LoadToolSet,
        message: "Tools send fields the connection's spec doesn't name",
        metadata: { companyId: params.companyId, tools: unmatched },
      });
    }

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.LoadToolSetApiResponse>> => {
        const connection = await this.resolveConnection(tx, {
          companyId: params.companyId,
          connectionPublicId: params.connectionPublicId,
        });
        if (!connection.isSuccess) return connection.response;

        const nameParams = {
          companyId: params.companyId,
          names: planned.map(({ tool }) => tool.name),
        };
        const locked = await this.dal.lockToolDefinitionNames(tx, nameParams);
        if (!locked.isSuccess) return locked;
        const latestRows = await this.dal.getLatestToolDefinitions(tx, nameParams);
        if (!latestRows.isSuccess || !latestRows.toolDefinitions) {
          return { isSuccess: false, message: latestRows.message };
        }
        const latestByName = new Map(latestRows.toolDefinitions.map((row) => [row.name, row]));
        // DEV_NOTE: A Draft is always a name's highest version: a new version starts at the highest + 1 and is refused
        // while a Draft exists, so the latest row tells whether one does
        const drafts = latestRows.toolDefinitions
          .filter((row) => row.status === Schemas.ToolDefinitionStatusIntEnum.Draft)
          .map((row) => row.name);
        if (drafts.length > 0) {
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.DraftExists,
            `These tools have a draft version; make it active or delete it first: ${drafts.join(", ")}`,
          );
        }
        // DEV_NOTE: Decide each tool against its newest version, then write in batches: new versions inserted Active,
        // Disabled ones made Active, and every audit row, each in one statement
        const tools: Schemas.ToolSetTool[] = [];
        const newVersions: Schemas.CreateToolDefinitionsDALRequest["toolDefinitions"] = [];
        const reactivate: string[] = [];
        for (const { tool, ops, schemaVersion, operationId, contractHash } of planned) {
          const latest = latestByName.get(tool.name);
          const content = {
            connectionId: connection.connectionId,
            description: tool.description,
            risk: tool.risk,
            idempotencyMode: tool.idempotencyMode,
            approval: tool.approval,
            source: tool.source,
            ...this.toOpsColumns(ops, schemaVersion),
            operationId,
            contractHash,
          };
          const isSame =
            latest !== undefined &&
            Utility.stableStringify(content) ===
              Utility.stableStringify({
                connectionId: latest.connectionId,
                description: latest.description,
                risk: latest.risk,
                idempotencyMode: latest.idempotencyMode,
                approval: latest.approval,
                source: latest.source,
                schemaVersion: latest.schemaVersion,
                inputSchema: latest.inputSchema,
                callOp: latest.callOp,
                readbackOp: latest.readbackOp,
                inverseOp: latest.inverseOp,
                operationId: latest.operationId,
                contractHash: latest.contractHash,
              });

          if (latest && isSame) {
            const isActive = latest.status === Schemas.ToolDefinitionStatusIntEnum.Active;
            if (!isActive) reactivate.push(latest.publicId);
            tools.push({
              name: tool.name,
              version: latest.version,
              change: isActive
                ? Schemas.ToolSetChangeEnum.Unchanged
                : Schemas.ToolSetChangeEnum.Reactivated,
            });
            continue;
          }
          const version = (latest?.version ?? 0) + 1;
          newVersions.push({ name: tool.name, version, ...content });
          tools.push({
            name: tool.name,
            version,
            change: latest
              ? Schemas.ToolSetChangeEnum.NewVersion
              : Schemas.ToolSetChangeEnum.Created,
          });
        }

        const audits: Parameters<
          typeof recordAuditsOrRollback<Schemas.AuditEntityTypeEnum.ToolDefinition>
        >[1]["events"] = [];
        const auditRow = (
          row: Pick<Schemas.ToolDefinition, "id" | "publicId" | "name" | "version">,
          entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.ToolDefinition>,
        ) =>
          audits.push({ entityAction, entity: row, entityVersion: row.version, label: row.name });

        if (newVersions.length > 0) {
          const created = await this.dal.createToolDefinitions(tx, {
            companyId: params.companyId,
            createdBy: params.adminId,
            status: Schemas.ToolDefinitionStatusIntEnum.Active,
            toolDefinitions: newVersions,
          });
          if (!created.isSuccess || !created.toolDefinitions) {
            throw new TenantRollbackError(created.message ?? "Tool definitions weren't created");
          }
          for (const row of created.toolDefinitions) {
            auditRow(
              row,
              row.version === 1
                ? Schemas.AuditEntityActionEnum.Created
                : Schemas.AuditEntityActionEnum.VersionCreated,
            );
            auditRow(row, Schemas.AuditEntityActionEnum.Activated);
          }
        }
        if (reactivate.length > 0) {
          const activated = await this.dal.activateToolDefinitions(tx, {
            companyId: params.companyId,
            updatedBy: params.adminId,
            publicIds: reactivate,
          });
          if (!activated.isSuccess || !activated.toolDefinitions) {
            throw new TenantRollbackError(
              activated.message ?? "Tool definitions weren't activated",
            );
          }
          for (const row of activated.toolDefinitions) {
            auditRow(row, Schemas.AuditEntityActionEnum.Activated);
          }
        }

        const outboxIds = await recordAuditsOrRollback(tx, {
          companyId: params.companyId,
          actor: operatorAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.ToolDefinition,
          events: audits,
        });
        return {
          isSuccess: true,
          message:
            unmatched.length > 0
              ? `Tool set loaded. These tools send fields the spec doesn't name, so the app may refuse them: ${unmatched.join("; ")}`
              : "Tool set loaded",
          tools,
          outboxIds,
        };
      },
    );
  }

  async deleteToolDefinition(params: {
    companyId: string;
    publicId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.DeleteToolDefinitionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.DeleteToolDefinitionApiResponse>> => {
        const found = await this.dal.getToolDefinitionDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.toolDefinition) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.toolDefinition.status !== Schemas.ToolDefinitionStatusIntEnum.Draft) {
          return this.refuse(
            Schemas.ToolDefinitionFailureEnum.NotDraft,
            "Only a draft version can be deleted; disable it instead",
          );
        }
        const deleted = await this.dal.deleteToolDefinitionDraft(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
        });
        if (!deleted.isSuccess) return deleted;
        const outboxId = await this.audit(
          tx,
          params,
          found.toolDefinition,
          Schemas.AuditEntityActionEnum.Deleted,
        );
        return { ...deleted, outboxIds: [outboxId] };
      },
    );
  }
}
