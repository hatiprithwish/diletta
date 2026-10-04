import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side from the signed-in admin; never from the client.
export default class ChatbotsRepo {
  private db: NodePgDatabase;
  private dal: ChatbotsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChatbotsDAL();
  }

  private withStatusLabel(chatbot: Schemas.Chatbot): Schemas.ChatbotWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      ...rest
    } = chatbot;
    return {
      ...rest,
      chatbotStatus: chatbot.status,
      chatbotStatusLabel: Schemas.CHATBOT_STATUS_LABEL_MAP[chatbot.status],
    };
  }

  private withChatbotResponse(result: Schemas.ChatbotDALResponse): Schemas.GetChatbotApiResponse {
    const { chatbot, ...rest } = result;
    return { ...rest, chatbot: chatbot ? this.withStatusLabel(chatbot) : undefined };
  }

  async createChatbot(
    params: Schemas.CreateChatbotApiRequest & { companyId: string },
  ): Promise<Schemas.CreateChatbotApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.createChatbot(tx, {
        companyId: params.companyId,
        name: params.chatbot.name,
      });
      return this.withChatbotResponse(result);
    });
  }

  async getChatbotDetails(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetChatbotApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getChatbotDetails(tx, params);
      return this.withChatbotResponse(result);
    });
  }

  async getChatbots(params: { companyId: string }): Promise<Schemas.GetChatbotsApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { chatbots, ...rest } = await this.dal.getChatbots(tx, params);
      return { ...rest, chatbots: chatbots?.map((chatbot) => this.withStatusLabel(chatbot)) };
    });
  }

  async updateChatbot(
    params: Schemas.UpdateChatbotApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.UpdateChatbotApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.updateChatbot(tx, {
        companyId: params.companyId,
        publicId: params.publicId,
        name: params.chatbot.name ?? null,
        status: params.chatbot.status ?? null,
      });
      return this.withChatbotResponse(result);
    });
  }

  async deleteChatbot(params: { companyId: string; publicId: string }) {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.deleteChatbot(tx, params);
    });
  }

  // DEV_NOTE: Transactional flow — clear the old default, then mark the new one. Any failed step throws
  // TenantRollbackError so withTenant rolls back and the previous default stays in place.
  async setDefaultChatbot(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.SetDefaultChatbotApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const cleared = await this.dal.clearDefaultChatbot(tx, { companyId: params.companyId });
      if (!cleared.isSuccess) {
        throw new TenantRollbackError(cleared.message);
      }

      const result = await this.dal.markDefaultChatbot(tx, params);
      if (!result.isSuccess) {
        throw new TenantRollbackError(result.message);
      }

      return this.withChatbotResponse(result);
    });
  }
}
