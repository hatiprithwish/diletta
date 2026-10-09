import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotConfigs } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). M2-2 reads the published config only; drafts,
// publish and rollback come with the dashboard (M4-10). body is returned raw: callers read it through loadConfigSpec.
export default class ChatbotConfigsDAL {
  // DEV_NOTE: isNotFound when the chatbot has no published config (it can't answer yet)
  async getPublishedChatbotConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindPublishedChatbotConfigDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Published),
      ];
      const [chatbotConfig] = await tx
        .select()
        .from(chatbotConfigs)
        .where(and(...conditions))
        .limit(1);

      if (!chatbotConfig) {
        const message = "Chatbot has no published config";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetPublishedChatbotConfig,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Published chatbot config fetched successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in fetching published chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPublishedChatbotConfig,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
