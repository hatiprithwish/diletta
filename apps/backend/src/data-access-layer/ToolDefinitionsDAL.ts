import { and, asc, count, desc, eq, getColumns, max, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, companyConnections, toolDefinitions } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

const NAME_VERSION_INDEX = "UNQ_tool_definitions_company_id_name_version";

// DEV_NOTE: A tool row with its connection's public id. Left join: there are no DB foreign keys, so a connection that
// is gone leaves connectionPublicId null instead of hiding the tool.
const rowSelection = {
  ...getColumns(toolDefinitions),
  connectionPublicId: companyConnections.publicId,
};
const connectionJoinConditions = [
  eq(companyConnections.id, toolDefinitions.connectionId),
  eq(companyConnections.companyId, toolDefinitions.companyId),
];

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). Versions are immutable once active, so edits and
// deletes match Draft rows only, whatever the Repo read before.
export default class ToolDefinitionsDAL {
  private async selectRow(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindToolDefinitionDALRequest,
  ) {
    const conditions = [
      eq(toolDefinitions.publicId, params.publicId),
      eq(toolDefinitions.companyId, params.companyId),
    ];
    const query = tx
      .select(rowSelection)
      .from(toolDefinitions)
      .leftJoin(companyConnections, and(...connectionJoinConditions))
      .where(and(...conditions))
      .limit(1);
    // DEV_NOTE: FOR UPDATE OF the tool row only: Postgres refuses to lock the nullable side of an outer join
    const [row] = params.isForUpdate
      ? await query.for("update", { of: toolDefinitions })
      : await query;
    return row;
  }

  async createToolDefinition(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateToolDefinitionDALRequest,
  ) {
    const response: Schemas.ToolDefinitionDALResponse = { isSuccess: false };
    const {
      inputSchema: _inputSchema,
      callOp: _callOp,
      readbackOp: _readbackOp,
      inverseOp: _inverseOp,
      ...metadata
    } = params;

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the company reference before writing, like every create (golden
      // ChatbotsDAL). The route's resolveOperatorCompany already found it; the check stays because a DAL never trusts
      // its caller for a reference. The connection is checked by the Repo (getToolConnection), which needs its state
      // to decide, not just its existence.
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateToolDefinition,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [created] = await tx
        .insert(toolDefinitions)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          connectionId: params.connectionId,
          name: params.name,
          version: params.version,
          description: params.description,
          risk: params.risk,
          schemaVersion: params.schemaVersion,
          inputSchema: params.inputSchema,
          callOp: params.callOp,
          readbackOp: params.readbackOp,
          inverseOp: params.inverseOp,
          idempotencyMode: params.idempotencyMode,
          approval: params.approval,
          source: params.source,
          createdBy: params.createdBy,
          updatedBy: params.createdBy,
        })
        .returning({ publicId: toolDefinitions.publicId });

      const row = await this.selectRow(tx, {
        publicId: created!.publicId,
        companyId: params.companyId,
        isForUpdate: false,
      });

      response.isSuccess = true;
      response.message = "Tool definition created successfully";
      response.toolDefinition = row;
    } catch (error) {
      const message = Utility.isUniqueViolation(error, NAME_VERSION_INDEX)
        ? "Tool definition version already exists"
        : "Unknown error in creating tool definition";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateToolDefinition,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async getToolDefinitionDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindToolDefinitionDALRequest,
  ) {
    const response: Schemas.ToolDefinitionDALResponse = { isSuccess: false };

    try {
      const toolDefinition = await this.selectRow(tx, params);

      if (!toolDefinition) {
        const message = "Tool definition not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetToolDefinitionDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tool definition fetched successfully";
      response.toolDefinition = toolDefinition;
    } catch (error) {
      const message = "Unknown error in fetching tool definition";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetToolDefinitionDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getToolDefinitions(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetToolDefinitionsDALRequest,
  ) {
    const response: Schemas.ToolDefinitionsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.ToolDefinitionSortColumn.CreatedAt]: toolDefinitions.createdAt,
        [Schemas.ToolDefinitionSortColumn.Name]: toolDefinitions.name,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const conditions = [eq(toolDefinitions.companyId, params.companyId)];
      if (params.name) conditions.push(eq(toolDefinitions.name, params.name));
      if (params.status) conditions.push(eq(toolDefinitions.status, params.status));

      const toolDefinitionsResponse = await tx
        .select(rowSelection)
        .from(toolDefinitions)
        .leftJoin(companyConnections, and(...connectionJoinConditions))
        .where(and(...conditions))
        // DEV_NOTE: id breaks ties (one name has many versions), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(toolDefinitions.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Tool definitions fetched successfully";
      response.toolDefinitions = toolDefinitionsResponse;
    } catch (error) {
      const message = "Unknown error in listing tool definitions";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListToolDefinitions,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getToolDefinitionsCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetToolDefinitionsCountDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const conditions = [eq(toolDefinitions.companyId, params.companyId)];
      if (params.name) conditions.push(eq(toolDefinitions.name, params.name));
      if (params.status) conditions.push(eq(toolDefinitions.status, params.status));

      const [result] = await tx
        .select({ count: count() })
        .from(toolDefinitions)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Tool definitions counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting tool definitions";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountToolDefinitions,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: isSuccess with no connection = not one of the company's connections (a client mistake, not logged as an
  // error). Status, adapter type and base_url come with it, so the Repo can refuse one that can't serve tool calls.
  async getToolConnection(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindToolConnectionDALRequest,
  ) {
    const response: Schemas.ToolConnectionDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(companyConnections.publicId, params.connectionPublicId),
        eq(companyConnections.companyId, params.companyId),
      ];
      const [connection] = await tx
        .select({
          id: companyConnections.id,
          status: companyConnections.status,
          adapterType: companyConnections.adapterType,
          baseUrl: companyConnections.baseUrl,
        })
        .from(companyConnections)
        .where(and(...conditions))
        .limit(1);

      response.isSuccess = true;
      response.message = connection ? "Connection found" : "Connection not found";
      response.connection = connection;
    } catch (error) {
      const message = "Unknown error in fetching tool connection";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetToolConnection,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Transaction-scoped advisory lock on (company, tool name), held until the Repo's transaction ends. Two
  // creates of the same name (a new tool, a new version) take turns, so the second reads the first one's version and
  // Draft instead of racing it to the unique index.
  async lockToolDefinitionName(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindToolDefinitionNameDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKey = `tool_definition:${params.companyId}:${params.name}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      response.isSuccess = true;
      response.message = "Tool definition name locked successfully";
    } catch (error) {
      const message = "Unknown error in locking tool definition name";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockToolDefinitionName,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getToolDefinitionNameState(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindToolDefinitionNameDALRequest,
  ) {
    const response: Schemas.ToolDefinitionNameDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(toolDefinitions.companyId, params.companyId),
        eq(toolDefinitions.name, params.name),
      ];
      const [result] = await tx
        .select({
          latestVersion: max(toolDefinitions.version),
          draftCount: sql<number>`count(*) filter (where ${toolDefinitions.status} = ${Schemas.ToolDefinitionStatusIntEnum.Draft})::int`,
        })
        .from(toolDefinitions)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Tool definition name state fetched successfully";
      response.latestVersion = result?.latestVersion ?? 0;
      response.hasDraft = (result?.draftCount ?? 0) > 0;
    } catch (error) {
      const message = "Unknown error in fetching tool definition name state";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetToolDefinitionNameState,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateToolDefinitionDraft(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateToolDefinitionDraftDALRequest,
  ) {
    const response: Schemas.ToolDefinitionDALResponse = { isSuccess: false };
    const { ops, ...metadata } = params;

    try {
      const now = new Date();
      const conditions = [
        eq(toolDefinitions.publicId, params.publicId),
        eq(toolDefinitions.companyId, params.companyId),
        eq(toolDefinitions.status, Schemas.ToolDefinitionStatusIntEnum.Draft),
      ];
      const [updated] = await tx
        .update(toolDefinitions)
        .set({
          // DEV_NOTE: When a param is null, it's ignored; ops are written as one unit or not at all
          connectionId: params.connectionId ?? undefined,
          description: params.description ?? undefined,
          risk: params.risk ?? undefined,
          ...(ops ?? {}),
          idempotencyMode: params.idempotencyMode ?? undefined,
          approval: params.approval ?? undefined,
          source: params.source ?? undefined,
          updatedBy: params.updatedBy,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning({ publicId: toolDefinitions.publicId });

      if (!updated) {
        const message = "Draft tool definition not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateToolDefinitionDraft,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tool definition updated successfully";
      response.toolDefinition = await this.selectRow(tx, { ...params, isForUpdate: false });
    } catch (error) {
      const message = "Unknown error in updating tool definition";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateToolDefinitionDraft,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async setToolDefinitionStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetToolDefinitionStatusDALRequest,
  ) {
    const response: Schemas.ToolDefinitionDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const conditions = [
        eq(toolDefinitions.publicId, params.publicId),
        eq(toolDefinitions.companyId, params.companyId),
      ];
      const [updated] = await tx
        .update(toolDefinitions)
        .set({ status: params.status, updatedBy: params.updatedBy, updatedAt: now })
        .where(and(...conditions))
        .returning({ publicId: toolDefinitions.publicId });

      if (!updated) {
        const message = "Tool definition not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SetToolDefinitionStatus,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tool definition status set successfully";
      response.toolDefinition = await this.selectRow(tx, { ...params, isForUpdate: false });
    } catch (error) {
      const message = "Unknown error in setting tool definition status";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetToolDefinitionStatus,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deleteToolDefinitionDraft(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteToolDefinitionDraftDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(toolDefinitions.publicId, params.publicId),
        eq(toolDefinitions.companyId, params.companyId),
        eq(toolDefinitions.status, Schemas.ToolDefinitionStatusIntEnum.Draft),
      ];
      const [deleted] = await tx
        .delete(toolDefinitions)
        .where(and(...conditions))
        .returning({ id: toolDefinitions.id });

      if (!deleted) {
        const message = "Draft tool definition not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteToolDefinitionDraft,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Tool definition deleted successfully";
    } catch (error) {
      const message = "Unknown error in deleting tool definition";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteToolDefinitionDraft,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
