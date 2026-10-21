import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { conversations, toolCalls, toolDefinitions } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). tool_calls holds every host tool call of a
// turn (M3-4); its args arrive encrypted, and only ids reach a log (rule 3.19: no ciphertext or iv in metadata).
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
}
