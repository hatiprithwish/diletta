import { and, asc, count, eq, gt, isNotNull } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { changeRequests, conversations, toolCalls, toolDefinitions } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). tool_calls holds every host tool call of a
// turn (M3-4); its args arrive encrypted, and only ids reach a log (no ciphertext or iv in metadata).
export default class ToolCallsDAL {
  async createToolCall(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateToolCallDALRequest,
  ) {
    const response: Schemas.ToolCallDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      conversationId: params.conversationId,
      toolId: params.toolId,
      toolVersion: params.toolVersion,
      turnId: params.turnId,
    };

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
      const toolConditions = [
        eq(toolDefinitions.id, params.toolId),
        eq(toolDefinitions.companyId, params.companyId),
        eq(toolDefinitions.version, params.toolVersion),
      ];
      const [tool] = await tx
        .select({ id: toolDefinitions.id })
        .from(toolDefinitions)
        .where(and(...toolConditions))
        .limit(1);

      if (!conversation || !tool) {
        const message = conversation ? "Tool definition not found" : "Conversation not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateToolCall,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [toolCall] = await tx
        .insert(toolCalls)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          conversationId: params.conversationId,
          turnId: params.turnId,
          toolId: params.toolId,
          toolVersion: params.toolVersion,
          encryptedArgs: params.encryptedArgs ? Buffer.from(params.encryptedArgs) : null,
          iv: params.iv ? Buffer.from(params.iv) : null,
          encryptionKeyVersion: params.encryptionKeyVersion,
          hasUntrustedContext: params.hasUntrustedContext,
          status: params.status,
          errorCode: params.errorCode,
          latencyMs: params.latencyMs,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Tool call recorded successfully";
      response.toolCall = toolCall;
    } catch (error) {
      const message = "Unknown error in recording tool call";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateToolCall,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The dashboard transcript (M4-4): every tool call of one conversation, oldest first, with its tool's name
  // and the change request it proposed. The args are never read (encrypted, never shown). Left joins: a call whose
  // definition is gone still lists, and only a write that proposed something has a change request.
  async listConversationToolCalls(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ListConversationToolCallsDALRequest,
  ) {
    const response: Schemas.TranscriptToolCallsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(toolCalls.companyId, params.companyId),
        eq(toolCalls.conversationId, params.conversationId),
      ];
      const toolJoinConditions = [
        eq(toolDefinitions.id, toolCalls.toolId),
        eq(toolDefinitions.companyId, toolCalls.companyId),
      ];
      const changeJoinConditions = [
        eq(changeRequests.toolCallId, toolCalls.id),
        eq(changeRequests.companyId, toolCalls.companyId),
      ];
      const rows = await tx
        .select({
          publicId: toolCalls.publicId,
          turnId: toolCalls.turnId,
          toolName: toolDefinitions.name,
          toolVersion: toolCalls.toolVersion,
          status: toolCalls.status,
          errorCode: toolCalls.errorCode,
          createdAt: toolCalls.createdAt,
          changePublicId: changeRequests.publicId,
          changeSummary: changeRequests.summary,
          changeCount: changeRequests.changeCount,
          changeStatus: changeRequests.status,
          changeErrorCode: changeRequests.errorCode,
        })
        .from(toolCalls)
        .leftJoin(toolDefinitions, and(...toolJoinConditions))
        .leftJoin(changeRequests, and(...changeJoinConditions))
        .where(and(...conditions))
        .orderBy(asc(toolCalls.id));

      response.isSuccess = true;
      response.message = "Conversation tool calls fetched successfully";
      response.toolCalls = rows.map(
        ({
          changePublicId,
          changeSummary,
          changeCount,
          changeStatus,
          changeErrorCode,
          ...row
        }) => ({
          ...row,
          change:
            changePublicId !== null &&
            changeSummary !== null &&
            changeCount !== null &&
            changeStatus !== null
              ? {
                  publicId: changePublicId,
                  summary: changeSummary,
                  changeCount,
                  status: changeStatus,
                  errorCode: changeErrorCode,
                }
              : null,
        }),
      );
    } catch (error) {
      const message = "Unknown error in listing conversation tool calls";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListConversationToolCalls,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Retention purge (M6-1): status, latency and error code stay
  async clearConversationArgs(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ClearConversationContentDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(toolCalls.conversationId, params.conversationId),
        eq(toolCalls.companyId, params.companyId),
      ];
      await tx
        .update(toolCalls)
        .set({ encryptedArgs: null, iv: null, encryptionKeyVersion: null, updatedAt: new Date() })
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Conversation content cleared";
    } catch (error) {
      const message = "Unknown error in clearing conversation content";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.PurgeConversationContent,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Key rotation job (M6-3): a batch still on encryptionKeyVersion, by id after afterId. A purged value (NULL) is never read. Ciphertext and
  // iv go back to the Repo only, never into log metadata.
  async getToolCallArgsOnKeyVersion(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetValuesOnKeyVersionDALRequest,
  ) {
    const response: Schemas.ValuesOnKeyVersionDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(toolCalls.companyId, params.companyId),
        eq(toolCalls.encryptionKeyVersion, params.encryptionKeyVersion),
        isNotNull(toolCalls.encryptedArgs),
      ];
      if (params.afterId) conditions.push(gt(toolCalls.id, params.afterId));
      const rows = await tx
        .select({ id: toolCalls.id, ciphertext: toolCalls.encryptedArgs, iv: toolCalls.iv })
        .from(toolCalls)
        .where(and(...conditions))
        .orderBy(asc(toolCalls.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Values on key version fetched successfully";
      response.values = rows.flatMap((row) =>
        row.ciphertext && row.iv
          ? [{ id: row.id, encryptedValue: { ciphertext: row.ciphertext, iv: row.iv } }]
          : [],
      );
    } catch (error) {
      const message = "Unknown error in fetching values on key version";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetValuesOnKeyVersion,
        message,
        error,
        metadata: { ...params, column: Schemas.EncryptedColumnEnum.ToolCallArgs },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Key rotation job (M6-3): compare-and-set on the version and iv read, so args rewritten since then keep
  // their new value (isUpdated false)
  async updateReEncryptedToolCallArgs(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateReEncryptedValueDALRequest,
  ) {
    const response: Schemas.UpdateReEncryptedValueDALResponse = { isSuccess: false };
    const { encryptedValue: _encryptedValue, fromIv: _fromIv, ...metadata } = params;

    try {
      const conditions = [
        eq(toolCalls.id, params.id),
        eq(toolCalls.companyId, params.companyId),
        eq(toolCalls.encryptionKeyVersion, params.fromEncryptionKeyVersion),
        eq(toolCalls.iv, Buffer.from(params.fromIv)),
      ];
      const updated = await tx
        .update(toolCalls)
        .set({
          encryptedArgs: Buffer.from(params.encryptedValue.ciphertext),
          iv: Buffer.from(params.encryptedValue.iv),
          encryptionKeyVersion: params.encryptionKeyVersion,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning({ id: toolCalls.id });

      response.isSuccess = true;
      response.message = "Re-encrypted value saved";
      response.isUpdated = updated.length > 0;
    } catch (error) {
      const message = "Unknown error in saving re-encrypted value";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateReEncryptedValue,
        message,
        error,
        metadata: { ...metadata, column: Schemas.EncryptedColumnEnum.ToolCallArgs },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Key rotation job (M6-3): what is left on a key version; 0 lets the job destroy it
  async getToolCallArgsOnKeyVersionCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountValuesOnKeyVersionDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(toolCalls.companyId, params.companyId),
        eq(toolCalls.encryptionKeyVersion, params.encryptionKeyVersion),
        isNotNull(toolCalls.encryptedArgs),
      ];
      const [result] = await tx
        .select({ totalRecords: count() })
        .from(toolCalls)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Values on key version counted successfully";
      response.totalRecords = result?.totalRecords ?? 0;
    } catch (error) {
      const message = "Unknown error in counting values on key version";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountValuesOnKeyVersion,
        message,
        error,
        metadata: { ...params, column: Schemas.EncryptedColumnEnum.ToolCallArgs },
      });
      response.message = message;
    }

    return response;
  }
}
