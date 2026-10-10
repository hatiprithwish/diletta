import { and, asc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotUsers, feedback, messages } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). feedback is a visitor's thumbs on one reply
// (M2-7): one row per (message, chatbot user), UNQ_feedback_message_id_chatbot_user_id.
export default class FeedbackDAL {
  // DEV_NOTE: The rating for one reply by one chatbot user: inserted, or the stored one replaced (a visitor switching
  // thumbs). The comment is kept as it is.
  async upsertFeedback(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpsertFeedbackDALRequest,
  ) {
    const response: Schemas.FeedbackDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks both references before writing
      const messageConditions = [
        eq(messages.id, params.messageId),
        eq(messages.companyId, params.companyId),
      ];
      const [message] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(...messageConditions))
        .limit(1);
      const chatbotUserConditions = [
        eq(chatbotUsers.id, params.chatbotUserId),
        eq(chatbotUsers.companyId, params.companyId),
      ];
      const [chatbotUser] = await tx
        .select({ id: chatbotUsers.id })
        .from(chatbotUsers)
        .where(and(...chatbotUserConditions))
        .limit(1);

      if (!message || !chatbotUser) {
        const errorMessage = message ? "Chatbot user not found" : "Message not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpsertFeedback,
          message: errorMessage,
          metadata: params,
        });
        response.message = errorMessage;
        return response;
      }

      const [feedbackResponse] = await tx
        .insert(feedback)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          messageId: params.messageId,
          chatbotUserId: params.chatbotUserId,
          rating: params.rating,
        })
        .onConflictDoUpdate({
          target: [feedback.messageId, feedback.chatbotUserId],
          set: { rating: params.rating, updatedAt: new Date() },
        })
        .returning();

      response.isSuccess = true;
      response.message = "Feedback saved successfully";
      response.feedback = feedbackResponse;
    } catch (error) {
      const message = "Unknown error in saving feedback";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpsertFeedback,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The ratings one chatbot user gave the replies of one conversation, as the widget names them (the reply's
  // Think message id), oldest reply first
  async listConversationFeedback(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ListConversationFeedbackDALRequest,
  ) {
    const response: Schemas.ConversationFeedbackDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedback.companyId, params.companyId),
        eq(feedback.chatbotUserId, params.chatbotUserId),
        eq(messages.companyId, params.companyId),
        eq(messages.conversationId, params.conversationId),
      ];
      const rows = await tx
        .select({ messageId: messages.sessionMessageId, rating: feedback.rating })
        .from(feedback)
        .innerJoin(messages, eq(messages.id, feedback.messageId))
        .where(and(...conditions))
        .orderBy(asc(messages.id));

      response.isSuccess = true;
      response.message = "Feedback fetched successfully";
      response.ratings = rows;
    } catch (error) {
      const message = "Unknown error in fetching feedback";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListConversationFeedback,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
