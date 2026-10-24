import { and, asc, count, eq, getColumns, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  changeRequests,
  chatbotUsers,
  chatbots,
  conversations,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
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
    const response: Schemas.ChangeRequestWriteDALResponse = { isSuccess: false };
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
    const response: Schemas.ChangeRequestWriteDALResponse = { isSuccess: false };
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
          ...(params.hostRef !== undefined ? { hostRef: params.hostRef } : {}),
          ...(params.undoUntil !== undefined ? { undoUntil: params.undoUntil } : {}),
          ...(params.payload
            ? {
                encryptedChanges: params.payload.encryptedChanges
                  ? Buffer.from(params.payload.encryptedChanges)
                  : null,
                iv: params.payload.iv ? Buffer.from(params.payload.iv) : null,
                encryptionKeyVersion: params.payload.encryptionKeyVersion,
              }
            : {}),
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

  // DEV_NOTE: An edit's re-checked payload (M3-5), only while the row is still Proposed (isNotFound otherwise: another
  // step decided it first). Sets was_edited.
  async updateChangeRequestPayload(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateChangeRequestPayloadDALRequest,
  ) {
    const response: Schemas.ChangeRequestWriteDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, id: params.id };

    try {
      const conditions = [
        eq(changeRequests.id, params.id),
        eq(changeRequests.companyId, params.companyId),
        eq(changeRequests.status, Schemas.ChangeRequestStatusIntEnum.Proposed),
      ];
      const [changeRequest] = await tx
        .update(changeRequests)
        .set({
          encryptedChanges: params.encryptedChanges ? Buffer.from(params.encryptedChanges) : null,
          iv: params.iv ? Buffer.from(params.iv) : null,
          encryptionKeyVersion: params.encryptionKeyVersion,
          summary: params.summary,
          changeCount: params.changeCount,
          wasEdited: true,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!changeRequest) {
        const message = "Change request is no longer Proposed";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateChangeRequestPayload,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Change request payload updated successfully";
      response.changeRequest = changeRequest;
    } catch (error) {
      const message = "Unknown error in updating change request payload";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateChangeRequestPayload,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Set once: a row that already holds this execution id succeeds unchanged; one that holds another is
  // refused (a pause is never re-pointed); no row of this conversation with that public id is isNotFound
  async setChangeRequestExecutionId(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetChangeRequestExecutionIdDALRequest,
  ) {
    const response: Schemas.ChangeRequestWriteDALResponse = { isSuccess: false };

    try {
      const rowConditions = [
        eq(changeRequests.publicId, params.publicId),
        eq(changeRequests.companyId, params.companyId),
        eq(changeRequests.conversationId, params.conversationId),
      ];
      const unsetConditions = [...rowConditions, isNull(changeRequests.thinkExecutionId)];
      const [changeRequest] = await tx
        .update(changeRequests)
        .set({ thinkExecutionId: params.thinkExecutionId, updatedAt: new Date() })
        .where(and(...unsetConditions))
        .returning();
      if (changeRequest) {
        response.isSuccess = true;
        response.message = "Change request execution id set";
        response.changeRequest = changeRequest;
        return response;
      }

      const [existing] = await tx
        .select()
        .from(changeRequests)
        .where(and(...rowConditions))
        .limit(1);
      if (!existing || existing.thinkExecutionId !== params.thinkExecutionId) {
        const message = existing
          ? "Change request holds another execution id"
          : "Change request not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SetChangeRequestExecutionId,
          message,
          metadata: idsOf(params),
        });
        response.message = message;
        response.isNotFound = !existing;
        return response;
      }
      response.isSuccess = true;
      response.message = "Change request execution id already set";
      response.changeRequest = existing;
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
  // DEV_NOTE: Platform (M3-7, withPlatform: the purge spans companies). Nulls the values of change requests whose
  // undo window ended, oldest first, at most limit per call, skipping rows another transaction holds (a step under way
  // purges on a later run). A Verified row holding the user's undo key is that undo under way: its values are what the
  // undo sends and checks, so it is spared until undo_until + CHANGE_REQUEST_UNDO_GRACE_MS (by then the DO has handed
  // it to a person). The key is built from the same constants as Schemas.changeRequestUserUndoIdempotencyKey.
  async purgeChangeRequestValues(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.PurgeChangeRequestValuesDALRequest,
  ) {
    const response: Schemas.PurgeChangeRequestValuesResponse = { isSuccess: false };

    try {
      const conditions = [
        lt(changeRequests.undoUntil, params.before),
        isNotNull(changeRequests.encryptedChanges),
        sql`NOT (${changeRequests.status} = ${Schemas.ChangeRequestStatusIntEnum.Verified} AND ${changeRequests.idempotencyKey} IS NOT DISTINCT FROM (${Schemas.CHANGE_REQUEST_KEY_PREFIX}::text || ${changeRequests.publicId} || ${Schemas.CHANGE_REQUEST_USER_UNDO_KEY_SUFFIX}::text) AND ${changeRequests.undoUntil} >= ${new Date(params.before.getTime() - Schemas.CHANGE_REQUEST_UNDO_GRACE_MS)})`,
      ];
      const due = tx
        .select({ id: changeRequests.id })
        .from(changeRequests)
        .where(and(...conditions))
        .orderBy(asc(changeRequests.undoUntil))
        .limit(params.limit)
        .for("update", { skipLocked: true });
      const purged = await tx
        .update(changeRequests)
        .set({
          encryptedChanges: null,
          iv: null,
          encryptionKeyVersion: null,
          updatedAt: new Date(),
        })
        .where(inArray(changeRequests.id, due))
        .returning({ id: changeRequests.id });

      response.isSuccess = true;
      response.message = "Change request values purged successfully";
      response.purgedCount = purged.length;
    } catch (error) {
      const message = "Unknown error in purging change request values";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.PurgeChangeRequestValues,
        message,
        error,
        metadata: { before: params.before.toISOString(), limit: params.limit },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Joined to the conversation for the chatbot (a change request has no chatbot of its own)
  async getChangeRequestsCountByStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountChangeRequestsByStatusDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(changeRequests.companyId, params.companyId),
        eq(changeRequests.status, params.status),
        eq(conversations.companyId, params.companyId),
      ];
      if (params.chatbotId !== null) conditions.push(eq(conversations.chatbotId, params.chatbotId));
      const [result] = await tx
        .select({ count: count() })
        .from(changeRequests)
        .innerJoin(conversations, eq(conversations.id, changeRequests.conversationId))
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Change requests counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting change requests";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountChangeRequestsByStatus,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The dashboard's change detail (M4-4): one change request by its public id within the company, with its
  // tool and the conversation it came from. Never its values: encrypted_changes isn't selected. Left joins on the tool
  // definition, conversation, chatbot and user (no DB foreign keys); the conversation's public id is required.
  async getDashboardChangeRequest(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindDashboardChangeRequestDALRequest,
  ) {
    const response: Schemas.DashboardChangeRequestDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(changeRequests.publicId, params.publicId),
        eq(changeRequests.companyId, params.companyId),
      ];
      const conversationJoinConditions = [
        eq(conversations.id, changeRequests.conversationId),
        eq(conversations.companyId, changeRequests.companyId),
      ];
      const chatbotJoinConditions = [
        eq(chatbots.id, conversations.chatbotId),
        eq(chatbots.companyId, conversations.companyId),
      ];
      const userJoinConditions = [
        eq(chatbotUsers.id, conversations.chatbotUserId),
        eq(chatbotUsers.companyId, conversations.companyId),
      ];
      const [selected] = await tx
        .select({
          publicId: changeRequests.publicId,
          summary: changeRequests.summary,
          changeCount: changeRequests.changeCount,
          status: changeRequests.status,
          errorCode: changeRequests.errorCode,
          wasEdited: changeRequests.wasEdited,
          undoUntil: changeRequests.undoUntil,
          createdAt: changeRequests.createdAt,
          updatedAt: changeRequests.updatedAt,
          toolName: toolDefinitions.name,
          toolVersion: toolCalls.toolVersion,
          conversationPublicId: conversations.publicId,
          conversationTitle: conversations.title,
          conversationContentPurgedAt: conversations.contentPurgedAt,
          chatbotName: chatbots.name,
          userName: chatbotUsers.displayName,
        })
        .from(changeRequests)
        .innerJoin(toolCalls, and(...toolCallJoinConditions))
        .leftJoin(toolDefinitions, and(...toolDefinitionJoinConditions))
        .innerJoin(conversations, and(...conversationJoinConditions))
        .leftJoin(chatbots, and(...chatbotJoinConditions))
        .leftJoin(chatbotUsers, and(...userJoinConditions))
        .where(and(...conditions))
        .limit(1);

      if (!selected) {
        const message = "Change request not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetDashboardChangeRequest,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Change request fetched successfully";
      response.changeRequest = selected;
    } catch (error) {
      const message = "Unknown error in fetching change request";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardChangeRequest,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
