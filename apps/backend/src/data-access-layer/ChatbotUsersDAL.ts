import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotUsers, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). hostUserId is the client-facing id.
export default class ChatbotUsersDAL {
  async createChatbotUser(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateChatbotUserDALRequest,
  ) {
    const response: Schemas.ChatbotUserDALResponse = { isSuccess: false };

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
          action: Schemas.LogAction.CreateChatbotUser,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [chatbotUserResponse] = await tx
        .insert(chatbotUsers)
        .values({
          companyId: params.companyId,
          hostUserId: params.hostUserId,
          displayName: params.displayName,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Chatbot user created successfully";
      response.chatbotUser = chatbotUserResponse;
    } catch (error) {
      const message = Utility.isUniqueViolation(error, "UNQ_chatbot_users_company_id_host_user_id")
        ? "Chatbot user already exists"
        : "Unknown error in creating chatbot user";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateChatbotUser,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotUserDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindChatbotUserDALRequest,
  ) {
    const response: Schemas.ChatbotUserDALResponse = { isSuccess: false };

    try {
      const [chatbotUser] = await tx
        .select()
        .from(chatbotUsers)
        .where(
          and(
            eq(chatbotUsers.hostUserId, params.hostUserId),
            eq(chatbotUsers.companyId, params.companyId),
          ),
        )
        .limit(1);

      if (!chatbotUser) {
        const message = "Chatbot user not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetChatbotUserDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot user fetched successfully";
      response.chatbotUser = chatbotUser;
    } catch (error) {
      const message = "Unknown error in fetching chatbot user";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotUserDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotUsers(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotUsersDALRequest,
  ) {
    const response: Schemas.ChatbotUsersDALResponse = { isSuccess: false };

    try {
      const chatbotUsersResponse = await tx
        .select()
        .from(chatbotUsers)
        .where(eq(chatbotUsers.companyId, params.companyId));

      response.isSuccess = true;
      response.message = "Chatbot users fetched successfully";
      response.chatbotUsers = chatbotUsersResponse;
    } catch (error) {
      const message = "Unknown error in listing chatbot users";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListChatbotUsers,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async updateChatbotUser(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateChatbotUserDALRequest,
  ) {
    const response: Schemas.ChatbotUserDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const [chatbotUserResponse] = await tx
        .update(chatbotUsers)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          displayName: params.displayName ?? undefined,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatbotUsers.hostUserId, params.hostUserId),
            eq(chatbotUsers.companyId, params.companyId),
          ),
        )
        .returning();

      if (!chatbotUserResponse) {
        const message = "Chatbot user not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateChatbotUser,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot user updated successfully";
      response.chatbotUser = chatbotUserResponse;
    } catch (error) {
      const message = "Unknown error in updating chatbot user";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateChatbotUser,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
