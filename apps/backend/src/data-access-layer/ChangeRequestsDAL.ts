import { and, eq, getColumns, inArray, isNull } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { changeRequests, conversations, toolCalls, toolDefinitions } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: A change request with its tool call's tool, version and turn, and the tool's name and inverse op. Inner
// join on the tool call (every change request has one, UNQ_change_requests_tool_call_id); left join on the tool
// definition, so a row whose tool is gone still reads (there are no DB foreign keys).
const rowSelection = {
  ...getColumns(changeRequests),
  toolId: toolCalls.toolId,
  toolVersion: toolCalls.toolVersion,
  turnId: toolCalls.turnId,
  toolName: toolDefinitions.name,
  toolRisk: toolDefinitions.risk,
  inverseOp: toolDefinitions.inverseOp,
};
const toolCallJoinConditions = [
  eq(toolCalls.id, changeRequests.toolCallId),
  eq(toolCalls.companyId, changeRequests.companyId),
];
const toolDefinitionJoinConditions = [
  eq(toolDefinitions.id, toolCalls.toolId),
  eq(toolDefinitions.companyId, toolCalls.companyId),
];

function toRow(
  selected: Omit<Schemas.ChangeRequestRow, "isUndoable"> & { inverseOp: unknown },
): Schemas.ChangeRequestRow {
  const { inverseOp, ...row } = selected;
  return { ...row, isUndoable: inverseOp !== null && inverseOp !== undefined };
}

// DEV_NOTE: Only ids reach a log: params may hold the encrypted payload (rule 3.19: no ciphertext or iv in metadata)
const idsOf = (params: { companyId: string; conversationId?: string; publicId?: string }) => ({
  companyId: params.companyId,
  conversationId: params.conversationId ?? null,
  publicId: params.publicId ?? null,
});

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). change_requests holds the writes the agent
// proposed (M3-4); status changes match the statuses they may start from, so a step that lost a race writes nothing.
export default class ChangeRequestsDAL {
  async createChangeRequest(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateChangeRequestDALRequest,
  ) {
    const response: Schemas.ChangeRequestUpdateDALResponse = { isSuccess: false };
    const metadata = { ...idsOf(params), toolCallId: params.toolCallId };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks both references before writing
      const conversationConditions = [
        eq(conversations.id, params.conversationId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(...conversationConditions))
        .limit(1);
      const toolCallConditions = [
        eq(toolCalls.id, params.toolCallId),
        eq(toolCalls.companyId, params.companyId),
        eq(toolCalls.conversationId, params.conversationId),
      ];
      const [toolCall] = await tx
        .select({ id: toolCalls.id })
        .from(toolCalls)
        .where(and(...toolCallConditions))
        .limit(1);

      if (!conversation || !toolCall) {
        const message = conversation ? "Tool call not found" : "Conversation not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateChangeRequest,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [changeRequest] = await tx
        .insert(changeRequests)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          conversationId: params.conversationId,
          toolCallId: params.toolCallId,
          status: params.status,
          encryptedChanges: params.encryptedChanges ? Buffer.from(params.encryptedChanges) : null,
          iv: params.iv ? Buffer.from(params.iv) : null,
          encryptionKeyVersion: params.encryptionKeyVersion,
          summary: params.summary,
          changeCount: params.changeCount,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Change request created successfully";
      response.changeRequest = changeRequest;
    } catch (error) {
      const message = "Unknown error in creating change request";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateChangeRequest,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async getChangeRequestDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindChangeRequestDALRequest,
  ) {
    const response: Schemas.ChangeRequestDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(changeRequests.publicId, params.publicId),
        eq(changeRequests.companyId, params.companyId),
        eq(changeRequests.conversationId, params.conversationId),
      ];
      const query = tx
        .select(rowSelection)
        .from(changeRequests)
        .innerJoin(toolCalls, and(...toolCallJoinConditions))
        .leftJoin(toolDefinitions, and(...toolDefinitionJoinConditions))
        .where(and(...conditions))
        .limit(1);
      // DEV_NOTE: FOR UPDATE OF the change request only: Postgres refuses to lock the nullable side of an outer join
      const [selected] = params.isForUpdate
        ? await query.for("update", { of: changeRequests })
        : await query;

      if (!selected) {
        const message = "Change request not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetChangeRequestDetails,
          message,
          metadata: idsOf(params),
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Change request fetched successfully";
      response.changeRequest = toRow(selected);
    } catch (error) {
      const message = "Unknown error in fetching change request";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChangeRequestDetails,
        message,
        error,
        metadata: idsOf(params),
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: isNotFound when the row isn't in one of fromStatuses (another step moved it first)
  async updateChangeRequestStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateChangeRequestStatusDALRequest,
  ) {
    const response: Schemas.ChangeRequestUpdateDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      id: params.id,
      status: params.status,
      fromStatuses: params.fromStatuses,
    };

    try {
      const conditions = [
        eq(changeRequests.id, params.id),
        eq(changeRequests.companyId, params.companyId),
        inArray(changeRequests.status, params.fromStatuses),
      ];
      const [changeRequest] = await tx
        .update(changeRequests)
        .set({
          status: params.status,
          ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
          ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!changeRequest) {
        const message = "Change request not in a status this step starts from";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateChangeRequestStatus,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Change request status updated successfully";
      response.changeRequest = changeRequest;
    } catch (error) {
      const message = "Unknown error in updating change request status";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateChangeRequestStatus,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Set once: a row that already has an execution id (or isn't this conversation's) is left as it is
  async setChangeRequestExecutionId(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetChangeRequestExecutionIdDALRequest,
  ) {
    const response: Schemas.ChangeRequestUpdateDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(changeRequests.publicId, params.publicId),
        eq(changeRequests.companyId, params.companyId),
        eq(changeRequests.conversationId, params.conversationId),
        isNull(changeRequests.thinkExecutionId),
      ];
      const [changeRequest] = await tx
        .update(changeRequests)
        .set({ thinkExecutionId: params.thinkExecutionId, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = changeRequest
        ? "Change request execution id set"
        : "Change request execution id already set";
      response.changeRequest = changeRequest;
    } catch (error) {
      const message = "Unknown error in setting change request execution id";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetChangeRequestExecutionId,
        message,
        error,
        metadata: idsOf(params),
      });
      response.message = message;
    }

    return response;
  }

  async listConversationChangeRequests(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ListConversationChangeRequestsDALRequest,
  ) {
    const response: Schemas.ChangeRequestsDALResponse = { isSuccess: false };

    try {
      if (params.publicIds.length === 0) {
        response.isSuccess = true;
        response.message = "No change requests asked for";
        response.changeRequests = [];
        return response;
      }
      const conditions = [
        eq(changeRequests.companyId, params.companyId),
        eq(changeRequests.conversationId, params.conversationId),
        inArray(changeRequests.publicId, params.publicIds),
      ];
      const selected = await tx
        .select(rowSelection)
        .from(changeRequests)
        .innerJoin(toolCalls, and(...toolCallJoinConditions))
        .leftJoin(toolDefinitions, and(...toolDefinitionJoinConditions))
        .where(and(...conditions))
        .orderBy(changeRequests.id);

      response.isSuccess = true;
      response.message = "Change requests fetched successfully";
      response.changeRequests = selected.map(toRow);
    } catch (error) {
      const message = "Unknown error in listing change requests";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListConversationChangeRequests,
        message,
        error,
        metadata: { companyId: params.companyId, conversationId: params.conversationId },
      });
      response.message = message;
    }

    return response;
  }
}
