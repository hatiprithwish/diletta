import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotUsersDAL from "@/data-access-layer/ChatbotUsersDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side; never from the client.
export default class ChatbotUsersRepo {
  private db: NodePgDatabase;
  private dal: ChatbotUsersDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChatbotUsersDAL();
  }

  private withoutInternalIds(chatbotUser: Schemas.ChatbotUser): Schemas.PublicChatbotUser {
    const { id: _id, companyId: _companyId, ...rest } = chatbotUser;
    return rest;
  }

  private withChatbotUserResponse(
    result: Schemas.ChatbotUserDALResponse,
  ): Schemas.GetChatbotUserApiResponse {
    const { chatbotUser, ...rest } = result;
    return { ...rest, chatbotUser: chatbotUser ? this.withoutInternalIds(chatbotUser) : undefined };
  }

  async createChatbotUser(
    params: Schemas.CreateChatbotUserApiRequest & { companyId: string },
  ): Promise<Schemas.CreateChatbotUserApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.createChatbotUser(tx, {
        companyId: params.companyId,
        hostUserId: params.chatbotUser.hostUserId,
        displayName: params.chatbotUser.displayName ?? null,
      });
      return this.withChatbotUserResponse(result);
    });
  }

  async getChatbotUserDetails(params: {
    companyId: string;
    hostUserId: string;
  }): Promise<Schemas.GetChatbotUserApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getChatbotUserDetails(tx, params);
      return this.withChatbotUserResponse(result);
    });
  }

  async getChatbotUsers(params: {
    companyId: string;
  }): Promise<Schemas.GetChatbotUsersApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { chatbotUsers, ...rest } = await this.dal.getChatbotUsers(tx, params);
      return {
        ...rest,
        chatbotUsers: chatbotUsers?.map((chatbotUser) => this.withoutInternalIds(chatbotUser)),
      };
    });
  }

  async updateChatbotUser(
    params: Schemas.UpdateChatbotUserApiRequest & { companyId: string; hostUserId: string },
  ): Promise<Schemas.UpdateChatbotUserApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.updateChatbotUser(tx, {
        companyId: params.companyId,
        hostUserId: params.hostUserId,
        displayName: params.chatbotUser.displayName,
      });
      return this.withChatbotUserResponse(result);
    });
  }
}
