import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotUsers, conversations, feedback, messages } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). feedback is a visitor's thumbs on one reply
// (M2-7): one row per (message, chatbot user), UNQ_feedback_message_id_chatbot_user_id.
export default class FeedbackDAL {
  // DEV_NOTE: The rating for one reply by one chatbot user: inserted, or the stored one replaced (a visitor switching
  // thumbs). A note belongs to the rating it was left on (M7-10): switching thumbs clears it, the same thumb again keeps it.
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
          set: {
            rating: params.rating,
            comment: sql`case when ${feedback.rating} = ${params.rating} then ${feedback.comment} end`,
            updatedAt: new Date(),
          },
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

  // DEV_NOTE: The note on one chatbot user's rating of one message (M7-10), replacing any earlier one, its version one
  // more. No rating row = isNotFound (a note is only ever left on a rating). The note is raw user text: it stays out of
  // every log.
  async setFeedbackComment(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetFeedbackCommentDALRequest,
  ) {
    const response: Schemas.FeedbackDALResponse = { isSuccess: false };
    const { comment: _comment, ...loggable } = params;

    try {
      const conditions = [
        eq(feedback.companyId, params.companyId),
        eq(feedback.messageId, params.messageId),
        eq(feedback.chatbotUserId, params.chatbotUserId),
      ];
      const [feedbackResponse] = await tx
        .update(feedback)
        .set({
          comment: params.comment,
          commentVersion: sql`${feedback.commentVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!feedbackResponse) {
        response.isNotFound = true;
        response.message = "Feedback not found";
        return response;
      }

      response.isSuccess = true;
      response.message = "Feedback note saved successfully";
      response.feedback = feedbackResponse;
    } catch (error) {
      const message = "Unknown error in saving the feedback note";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetFeedbackComment,
        message,
        error,
        metadata: loggable,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The ratings one chatbot user gave the replies of one conversation, as the widget names them (the reply's
  // Think message id), the newest replies' first and at most params.limit (they travel in a request header)
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
        .select({
          messageId: messages.sessionMessageId,
          rating: feedback.rating,
          hasNote: sql<boolean>`${feedback.comment} is not null`,
        })
        .from(feedback)
        .innerJoin(messages, eq(messages.id, feedback.messageId))
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(params.limit);

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

  // DEV_NOTE: Activity rollups (M4-2): ratings given in [start, end) (created_at), per chatbot (the reply's
  // conversation) and current rating, so a thumb switched later counts as it stands now, on the day it was first given
  async getFeedbackRollupGroups(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ActivityRollupWindowDALRequest,
  ) {
    const response: Schemas.FeedbackRollupGroupsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedback.companyId, params.companyId),
        eq(messages.companyId, params.companyId),
        eq(conversations.companyId, params.companyId),
        gte(feedback.createdAt, params.start),
        lt(feedback.createdAt, params.end),
      ];
      const groups = await tx
        .select({
          chatbotId: conversations.chatbotId,
          rating: feedback.rating,
          count: count(),
        })
        .from(feedback)
        .innerJoin(messages, eq(messages.id, feedback.messageId))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...conditions))
        .groupBy(conversations.chatbotId, feedback.rating);

      response.isSuccess = true;
      response.message = "Feedback rollup groups fetched successfully";
      response.groups = groups;
    } catch (error) {
      const message = "Unknown error in fetching feedback rollup groups";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFeedbackRollupGroups,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Retention purge (M6-1): the rating stays, any free text goes
  async clearConversationComments(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ClearConversationContentDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const messageConditions = [
        eq(messages.conversationId, params.conversationId),
        eq(messages.companyId, params.companyId),
      ];
      const chatMessages = tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(...messageConditions));
      const conditions = [
        inArray(feedback.messageId, chatMessages),
        eq(feedback.companyId, params.companyId),
      ];
      await tx
        .update(feedback)
        .set({ comment: null, updatedAt: new Date() })
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
}
