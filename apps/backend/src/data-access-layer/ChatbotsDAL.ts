import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbots, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS).
export default class ChatbotsDAL {
  async createChatbot(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateChatbotDALRequest,
  ) {
    const response: Schemas.ChatbotDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateChatbot,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [chatbotResponse] = await tx
        .insert(chatbots)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          name: params.name,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Chatbot created successfully";
      response.chatbot = chatbotResponse;
    } catch (error) {
      const message = "Unknown error in creating chatbot";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateChatbot,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindChatbotDALRequest,
  ) {
    const response: Schemas.ChatbotDALResponse = { isSuccess: false };

    try {
      const [chatbot] = await tx
        .select()
        .from(chatbots)
        .where(
          and(eq(chatbots.publicId, params.publicId), eq(chatbots.companyId, params.companyId)),
        )
        .limit(1);

      if (!chatbot) {
        const message = "Chatbot not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetChatbotDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot fetched successfully";
      response.chatbot = chatbot;
    } catch (error) {
      const message = "Unknown error in fetching chatbot";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbots(tx: NodePgTransaction<EmptyRelations>, params: Schemas.GetChatbotsDALRequest) {
    const response: Schemas.ChatbotsDALResponse = { isSuccess: false };

    try {
      const chatbotsResponse = await tx
        .select()
        .from(chatbots)
        .where(eq(chatbots.companyId, params.companyId));

      response.isSuccess = true;
      response.message = "Chatbots fetched successfully";
      response.chatbots = chatbotsResponse;
    } catch (error) {
      const message = "Unknown error in listing chatbots";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListChatbots,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateChatbot(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateChatbotDALRequest,
  ) {
    const response: Schemas.ChatbotDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const [chatbotResponse] = await tx
        .update(chatbots)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          name: params.name ?? undefined,
          status: params.status ?? undefined,
          updatedAt: now,
        })
        .where(
          and(eq(chatbots.publicId, params.publicId), eq(chatbots.companyId, params.companyId)),
        )
        .returning();

      if (!chatbotResponse) {
        const message = "Chatbot not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateChatbot,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot updated successfully";
      response.chatbot = chatbotResponse;
    } catch (error) {
      const message = "Unknown error in updating chatbot";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateChatbot,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deleteChatbot(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindChatbotDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const [deleted] = await tx
        .delete(chatbots)
        .where(
          and(eq(chatbots.publicId, params.publicId), eq(chatbots.companyId, params.companyId)),
        )
        .returning({ id: chatbots.id });

      if (!deleted) {
        const message = "Chatbot not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.DeleteChatbot,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot deleted successfully";
    } catch (error) {
      const message = "Unknown error in deleting chatbot";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteChatbot,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Succeeds when the company has no default chatbot yet — zero rows cleared is fine
  async clearDefaultChatbot(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ClearDefaultChatbotDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const now = new Date();
      await tx
        .update(chatbots)
        .set({ isDefault: false, updatedAt: now })
        .where(and(eq(chatbots.companyId, params.companyId), eq(chatbots.isDefault, true)));

      response.isSuccess = true;
      response.message = "Default chatbot cleared successfully";
    } catch (error) {
      const message = "Unknown error in clearing default chatbot";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ClearDefaultChatbot,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async markDefaultChatbot(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindChatbotDALRequest,
  ) {
    const response: Schemas.ChatbotDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const [chatbotResponse] = await tx
        .update(chatbots)
        .set({ isDefault: true, updatedAt: now })
        .where(
          and(eq(chatbots.publicId, params.publicId), eq(chatbots.companyId, params.companyId)),
        )
        .returning();

      if (!chatbotResponse) {
        const message = "Chatbot not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SetDefaultChatbot,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Default chatbot set successfully";
      response.chatbot = chatbotResponse;
    } catch (error) {
      const message = "Unknown error in setting default chatbot";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetDefaultChatbot,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
