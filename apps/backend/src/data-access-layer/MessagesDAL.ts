import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { conversations, messages } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). messages is the read model of the Think
// transcript: written after each turn, never read into one. content is chat text, so it stays out of every log.
export default class MessagesDAL {
  // DEV_NOTE: One turn's messages in one insert. A message already stored (same conversation, same Think message id,
  // UNQ_messages_conversation_id_session_message_id) is skipped, so a retried write never duplicates it; the response
  // carries only the rows this call inserted.
  async createMessages(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateMessagesDALRequest,
  ) {
    const response: Schemas.MessagesDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      sessionMessageIds: params.messages.map((message) => message.sessionMessageId),
    };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const conditions = [
        eq(conversations.id, params.conversationId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(...conditions))
        .limit(1);
      if (!conversation) {
        const message = "Conversation not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateMessages,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      if (params.messages.length === 0) {
        response.isSuccess = true;
        response.message = "No messages to create";
        response.messages = [];
        return response;
      }

      const messagesResponse = await tx
        .insert(messages)
        .values(
          params.messages.map((message) => ({
            publicId: Utility.generatePublicId(),
            companyId: params.companyId,
            conversationId: params.conversationId,
            sessionMessageId: message.sessionMessageId,
            turnId: params.turnId,
            role: message.role,
            content: message.content,
          })),
        )
        .onConflictDoNothing({ target: [messages.conversationId, messages.sessionMessageId] })
        .returning();

      response.isSuccess = true;
      response.message = "Messages created successfully";
      response.messages = messagesResponse;
    } catch (error) {
      const message = "Unknown error in creating messages";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateMessages,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }
}
