import { and, eq, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { chatbotUsers, chatbots, conversations } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). title is chat content (the first user
// message), so it stays out of every log.
export default class ConversationsDAL {
  async createConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateConversationDALRequest,
  ) {
    const response: Schemas.ConversationDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing
      const chatbotConditions = [
        eq(chatbots.id, params.chatbotId),
        eq(chatbots.companyId, params.companyId),
      ];
      const [chatbot] = await tx
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(...chatbotConditions))
        .limit(1);
      if (!chatbot) {
        const message = "Chatbot not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateConversation,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const chatbotUserConditions = [
        eq(chatbotUsers.id, params.chatbotUserId),
        eq(chatbotUsers.companyId, params.companyId),
      ];
      const [chatbotUser] = await tx
        .select({ id: chatbotUsers.id })
        .from(chatbotUsers)
        .where(and(...chatbotUserConditions))
        .limit(1);
      if (!chatbotUser) {
        const message = "Chatbot user not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateConversation,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [conversationResponse] = await tx
        .insert(conversations)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          chatbotUserId: params.chatbotUserId,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Conversation created successfully";
      response.conversation = conversationResponse;
    } catch (error) {
      const message = "Unknown error in creating conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateConversation,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getConversationDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindConversationDALRequest,
  ) {
    const response: Schemas.ConversationDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(conversations.publicId, params.publicId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(and(...conditions))
        .limit(1);

      if (!conversation) {
        const message = "Conversation not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetConversationDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Conversation fetched successfully";
      response.conversation = conversation;
    } catch (error) {
      const message = "Unknown error in fetching conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetConversationDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async setConversationRootLog(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetConversationRootLogDALRequest,
  ) {
    return await this.update(tx, params, Schemas.LogAction.SetConversationRootLog, {
      rootLogId: params.rootLogId,
    });
  }

  async setConversationConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetConversationConfigDALRequest,
  ) {
    return await this.update(tx, params, Schemas.LogAction.SetConversationConfig, {
      chatbotConfigId: params.chatbotConfigId,
    });
  }

  // DEV_NOTE: The title is set once, from the first turn: COALESCE keeps one already stored
  async touchConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.TouchConversationDALRequest,
  ) {
    const { title: _title, ...metadata } = params;
    return await this.update(tx, metadata, Schemas.LogAction.TouchConversation, {
      lastActivityAt: new Date(),
      title:
        params.title === null ? undefined : sql`COALESCE(${conversations.title}, ${params.title})`,
    });
  }

  // DEV_NOTE: Only an Open conversation closes; isNotFound when it is gone or already closed
  async closeConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CloseConversationDALRequest,
  ) {
    return await this.update(
      tx,
      params,
      Schemas.LogAction.CloseConversation,
      {
        status: Schemas.ConversationStatusIntEnum.Closed,
        outcome: params.outcome,
      },
      eq(conversations.status, Schemas.ConversationStatusIntEnum.Open),
    );
  }

  // DEV_NOTE: One conversation found by publicId within its company (plus an optional extra condition); updatedAt is
  // set here. isNotFound when no row matched.
  private async update(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindConversationDALRequest,
    action: Schemas.LogAction,
    values: PgUpdateSetSource<typeof conversations>,
    extraCondition?: ReturnType<typeof eq>,
  ) {
    const response: Schemas.ConversationDALResponse = { isSuccess: false };
    const metadata = { ...params };

    try {
      const conditions = [
        eq(conversations.publicId, params.publicId),
        eq(conversations.companyId, params.companyId),
      ];
      if (extraCondition) conditions.push(extraCondition);
      const [conversationResponse] = await tx
        .update(conversations)
        .set({ ...values, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!conversationResponse) {
        const message = "Conversation not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Conversation updated successfully";
      response.conversation = conversationResponse;
    } catch (error) {
      const message = "Unknown error in updating conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }
}
