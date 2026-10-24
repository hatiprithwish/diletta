import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotConfigs, chatbots } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). M2-2 reads the published config, M4-4 lists the ever
// published ones (a filter); drafts, publish and rollback come with the dashboard (M4-10). body is returned raw: callers read it through loadConfigSpec.
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

  // DEV_NOTE: The Conversations page's Config filter (M4-4): every config of the company's chatbots that was ever
  // published, by chatbot name, newest version first. Inner join: a config whose chatbot is gone has no name to show.
  async getChatbotConfigOptions(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigOptionsDALRequest,
  ) {
    const response: Schemas.ChatbotConfigOptionsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.companyId, params.companyId),
        isNotNull(chatbotConfigs.publishedAt),
      ];
      const chatbotJoinConditions = [
        eq(chatbots.id, chatbotConfigs.chatbotId),
        eq(chatbots.companyId, chatbotConfigs.companyId),
      ];
      const options = await tx
        .select({
          id: chatbotConfigs.id,
          publicId: chatbotConfigs.publicId,
          chatbotId: chatbotConfigs.chatbotId,
          chatbotName: chatbots.name,
          configVersion: chatbotConfigs.configVersion,
        })
        .from(chatbotConfigs)
        .innerJoin(chatbots, and(...chatbotJoinConditions))
        .where(and(...conditions))
        .orderBy(asc(chatbots.name), desc(chatbotConfigs.configVersion), asc(chatbotConfigs.id));

      response.isSuccess = true;
      response.message = "Chatbot config options fetched successfully";
      response.options = options;
    } catch (error) {
      const message = "Unknown error in fetching chatbot config options";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotConfigOptions,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
