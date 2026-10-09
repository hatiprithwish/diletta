import { and, asc, count, desc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotUsers, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: One chatbot user per host user id in a company
const HOST_USER_ID_INDEX = "UNQ_chatbot_users_company_id_host_user_id";

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
      const message = Utility.isUniqueViolation(error, HOST_USER_ID_INDEX)
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
      const conditions = [
        eq(chatbotUsers.hostUserId, params.hostUserId),
        eq(chatbotUsers.companyId, params.companyId),
      ];
      const [chatbotUser] = await tx
        .select()
        .from(chatbotUsers)
        .where(and(...conditions))
        .limit(1);

      // DEV_NOTE: Expected on a user's first visit (the widget route creates the row then), so a warning
      if (!chatbotUser) {
        const message = "Chatbot user not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetChatbotUserDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
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
      const sortColumnMap = {
        [Schemas.ChatbotUserSortColumn.CreatedAt]: chatbotUsers.createdAt,
        [Schemas.ChatbotUserSortColumn.HostUserId]: chatbotUsers.hostUserId,
        [Schemas.ChatbotUserSortColumn.DisplayName]: chatbotUsers.displayName,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const chatbotUsersResponse = await tx
        .select()
        .from(chatbotUsers)
        .where(eq(chatbotUsers.companyId, params.companyId))
        // DEV_NOTE: id breaks ties (same created_at or display name), so rows never repeat or go missing
        // between pages
        .orderBy(orderExpr, asc(chatbotUsers.id))
        .limit(params.pageSize)
        .offset(offset);

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

  async getChatbotUsersCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotUsersCountDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const [result] = await tx
        .select({ count: count() })
        .from(chatbotUsers)
        .where(eq(chatbotUsers.companyId, params.companyId));

      response.isSuccess = true;
      response.message = "Chatbot users counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting chatbot users";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountChatbotUsers,
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
      const conditions = [
        eq(chatbotUsers.hostUserId, params.hostUserId),
        eq(chatbotUsers.companyId, params.companyId),
      ];
      const [chatbotUserResponse] = await tx
        .update(chatbotUsers)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          displayName: params.displayName ?? undefined,
          updatedAt: now,
        })
        .where(and(...conditions))
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
