import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import FeedbackDAL from "@/data-access-layer/FeedbackDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: Feedback (M2-7): a visitor's thumbs on a reply, from the widget's feedback frame through the Conversation
// DO. Every internal id comes from the DO's verified session; the widget names the reply only by its Think message id,
// and only a synced reply of this very conversation matches, so a visitor can rate nothing but their own replies.
// M2-8 adds the quality issue a thumbs-down opens.
export default class FeedbackRepo {
  private db: NodePgDatabase;
  private feedbackDal: FeedbackDAL;
  private messagesDal: MessagesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.feedbackDal = new FeedbackDAL();
    this.messagesDal = new MessagesDAL();
  }

  // DEV_NOTE: The reply (an assistant message of the session's conversation, by Think message id) gets the rating, the
  // user's earlier one on it replaced. isNotFound when no synced reply has that id.
  async recordFeedback(params: {
    session: Schemas.ConversationSession;
    sessionMessageId: string;
    rating: Schemas.FeedbackRatingIntEnum;
  }): Promise<Schemas.RecordFeedbackResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const found = await this.messagesDal.getAssistantMessage(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        sessionMessageId: params.sessionMessageId,
      });
      if (!found.isSuccess || !found.chatMessage) {
        return { isSuccess: false, isNotFound: found.isNotFound, message: found.message };
      }

      const saved = await this.feedbackDal.upsertFeedback(tx, {
        companyId: session.companyId,
        messageId: found.chatMessage.id,
        chatbotUserId: session.chatbotUserId,
        rating: params.rating,
      });
      if (!saved.isSuccess || !saved.feedback) {
        return { isSuccess: false, message: saved.message };
      }

      return {
        isSuccess: true,
        message: saved.message,
        rating: { messageId: params.sessionMessageId, rating: saved.feedback.rating },
      };
    });
  }

  // DEV_NOTE: The ratings the session's user gave this conversation's replies, sent to the widget on connect
  async listConversationFeedback(params: {
    session: Schemas.ConversationSession;
  }): Promise<Schemas.ConversationFeedbackResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      return await this.feedbackDal.listConversationFeedback(tx, {
        companyId: session.companyId,
        chatbotUserId: session.chatbotUserId,
        conversationId: session.conversationId,
      });
    });
  }
}
