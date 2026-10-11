import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The status re-check every turn (ConversationsRepo.loadTurnConfig) and every change request step
// (ActionEngineRepo) starts with, in the caller's transaction (pattern rule 1.1: one step several Repos share; it never
// opens a transaction and never throws): the conversation open, its company and chatbot active (rule 3.23: never only
// at connect). The DALs log their own failures; each failure names its own cause.
export default class ConversationCheckProvider {
  private static conversationsDal = new ConversationsDAL();
  private static companiesDal = new CompaniesDAL();
  private static chatbotsDal = new ChatbotsDAL();

  static async check(
    tx: NodePgTransaction<EmptyRelations>,
    session: Schemas.ConversationSession,
  ): Promise<Schemas.ConversationCheckResponse> {
    const refuse = (
      failure: Schemas.ConversationCheckFailureEnum,
      message: string | undefined,
    ) => ({
      isSuccess: false as const,
      failure,
      message: message ?? failure,
    });

    const found = await ConversationCheckProvider.conversationsDal.getConversationDetails(tx, {
      companyId: session.companyId,
      publicId: session.conversationPublicId,
    });
    if (!found.isSuccess || !found.conversation) {
      return refuse(
        found.isNotFound
          ? Schemas.ConversationCheckFailureEnum.NotFound
          : Schemas.ConversationCheckFailureEnum.ServerError,
        found.message,
      );
    }
    if (found.conversation.status !== Schemas.ConversationStatusIntEnum.Open) {
      return refuse(
        Schemas.ConversationCheckFailureEnum.ConversationClosed,
        "Conversation is closed",
      );
    }

    const company = await ConversationCheckProvider.companiesDal.getCompanyDetails(tx, {
      companyId: session.companyId,
    });
    if (!company.isSuccess || !company.company) {
      return refuse(
        company.isNotFound
          ? Schemas.ConversationCheckFailureEnum.ChatbotUnavailable
          : Schemas.ConversationCheckFailureEnum.ServerError,
        company.message,
      );
    }
    const chatbot = await ConversationCheckProvider.chatbotsDal.getChatbotDetails(tx, {
      companyId: session.companyId,
      publicId: session.chatbotPublicId,
    });
    if (!chatbot.isSuccess || !chatbot.chatbot) {
      return refuse(
        chatbot.isNotFound
          ? Schemas.ConversationCheckFailureEnum.ChatbotUnavailable
          : Schemas.ConversationCheckFailureEnum.ServerError,
        chatbot.message,
      );
    }
    if (
      company.company.status !== Schemas.CompanyStatusIntEnum.Active ||
      chatbot.chatbot.status !== Schemas.ChatbotStatusIntEnum.Active
    ) {
      return refuse(
        Schemas.ConversationCheckFailureEnum.ChatbotUnavailable,
        "Chatbot or company is not active",
      );
    }
    return { isSuccess: true, conversation: found.conversation, company: company.company };
  }
}
