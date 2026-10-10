import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import FeedbackDAL from "@/data-access-layer/FeedbackDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import Constants from "@/config/Constants";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import UserQualityIssueProvider from "@/providers/userQualityIssue";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Feedback (M2-7): a visitor's thumbs on a reply, from the widget's feedback frame through the Conversation
// DO. Every internal id comes from the DO's verified session; the widget names the reply only by its Think message id,
// and only a synced reply of this very conversation matches, so a visitor can rate nothing but their own replies.
// A thumbs-down also opens a user quality issue (M2-8, UserQualityIssueProvider) in the same transaction.
export default class FeedbackRepo {
  private db: NodePgDatabase;
  private feedbackDal: FeedbackDAL;
  private messagesDal: MessagesDAL;
  private conversationsDal: ConversationsDAL;
  private companiesDal: CompaniesDAL;
  private chatbotsDal: ChatbotsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.feedbackDal = new FeedbackDAL();
    this.messagesDal = new MessagesDAL();
    this.conversationsDal = new ConversationsDAL();
    this.companiesDal = new CompaniesDAL();
    this.chatbotsDal = new ChatbotsDAL();
  }

  // DEV_NOTE: The reply (an assistant message of the session's conversation, by Think message id) gets the rating, the
  // user's earlier one on it replaced. Statuses are re-checked on every rating, never only at connect (rule 3.23): the
  // conversation must still be open, the company and chatbot active. failure says why nothing was stored. A Down opens
  // the rating's user issue (status Open, untriaged) and its quality_issue.opened event, or rolls the rating back with
  // them; the issue stays when the visitor later switches to Up, and a second Down opens nothing new (M2-8). outboxId
  // is the event to relay after the commit.
  async recordFeedback(params: {
    session: Schemas.ConversationSession;
    sessionMessageId: string;
    rating: Schemas.FeedbackRatingIntEnum;
  }): Promise<Schemas.RecordFeedbackResponse> {
    const { session } = params;
    const refuse = (failure: Schemas.RecordFeedbackFailureEnum, message?: string) => ({
      isSuccess: false,
      isNotFound: failure === Schemas.RecordFeedbackFailureEnum.NotFound,
      message,
      failure,
    });

    return await withTenant(this.db, session.companyId, async (tx) => {
      const conversation = await this.conversationsDal.getConversationDetails(tx, {
        companyId: session.companyId,
        publicId: session.conversationPublicId,
      });
      if (!conversation.isSuccess || !conversation.conversation) {
        return refuse(
          conversation.isNotFound
            ? Schemas.RecordFeedbackFailureEnum.NotFound
            : Schemas.RecordFeedbackFailureEnum.ServerError,
          conversation.message,
        );
      }
      if (conversation.conversation.status !== Schemas.ConversationStatusIntEnum.Open) {
        return refuse(
          Schemas.RecordFeedbackFailureEnum.ConversationClosed,
          "Conversation is closed",
        );
      }

      const company = await this.companiesDal.getCompanyDetails(tx, {
        companyId: session.companyId,
      });
      const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
        companyId: session.companyId,
        publicId: session.chatbotPublicId,
      });
      if (!company.isSuccess || !chatbot.isSuccess) {
        return chatbot.isNotFound
          ? refuse(Schemas.RecordFeedbackFailureEnum.ChatbotUnavailable, chatbot.message)
          : refuse(
              Schemas.RecordFeedbackFailureEnum.ServerError,
              company.message ?? chatbot.message,
            );
      }
      if (
        company.company?.status !== Schemas.CompanyStatusIntEnum.Active ||
        chatbot.chatbot?.status !== Schemas.ChatbotStatusIntEnum.Active
      ) {
        return refuse(
          Schemas.RecordFeedbackFailureEnum.ChatbotUnavailable,
          "Chatbot or company is not active",
        );
      }

      const found = await this.messagesDal.getAssistantMessage(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        sessionMessageId: params.sessionMessageId,
      });
      if (!found.isSuccess || !found.chatMessage) {
        return refuse(
          found.isNotFound
            ? Schemas.RecordFeedbackFailureEnum.NotFound
            : Schemas.RecordFeedbackFailureEnum.ServerError,
          found.message,
        );
      }

      const saved = await this.feedbackDal.upsertFeedback(tx, {
        companyId: session.companyId,
        messageId: found.chatMessage.id,
        chatbotUserId: session.chatbotUserId,
        rating: params.rating,
      });
      if (!saved.isSuccess || !saved.feedback) {
        return refuse(Schemas.RecordFeedbackFailureEnum.ServerError, saved.message);
      }
      const rating = { messageId: params.sessionMessageId, rating: saved.feedback.rating };
      if (saved.feedback.rating !== Schemas.FeedbackRatingIntEnum.Down) {
        return { isSuccess: true, message: saved.message, rating };
      }

      const opened = await UserQualityIssueProvider.open(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        conversationRootLogId: conversation.conversation.rootLogId,
        chatbotUserId: session.chatbotUserId,
        messageId: found.chatMessage.id,
        feedbackId: saved.feedback.id,
      });
      if (!opened.isSuccess) {
        throw new TenantRollbackError(opened.message ?? "User quality issue not opened");
      }

      return { isSuccess: true, message: saved.message, rating, outboxId: opened.outboxId };
    });
  }

  // DEV_NOTE: The ratings the session's user gave this conversation's replies, sent to the widget on connect (the
  // newest CONVERSATION_FEEDBACK_MAX_RATINGS replies' only: they travel in a request header)
  async listConversationFeedback(params: {
    session: Schemas.ConversationSession;
  }): Promise<Schemas.ConversationFeedbackResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      return await this.feedbackDal.listConversationFeedback(tx, {
        companyId: session.companyId,
        chatbotUserId: session.chatbotUserId,
        conversationId: session.conversationId,
        limit: Constants.CONVERSATION_FEEDBACK_MAX_RATINGS,
      });
    });
  }
}
