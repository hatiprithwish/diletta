import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AuditEventProvider from "@/providers/auditEvent";
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

  // DEV_NOTE: An admin's audit row (M4-9) in the write's transaction; a failure rolls the write back
  private async audit(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; adminId: string },
    chatbot: Schemas.Chatbot,
    entityAction: Schemas.AuditEntityActionEnum,
  ): Promise<string> {
    const audited = await AuditEventProvider.record(tx, {
      companyId: params.companyId,
      actor: { actorType: Schemas.ActivityLogActorTypeIntEnum.Admin, actorId: params.adminId },
      entityType: Schemas.AuditEntityTypeEnum.Chatbot,
      entityAction,
      entityId: chatbot.id,
      entityPublicId: chatbot.publicId,
      label: chatbot.name,
    });
    if (!audited.isSuccess || !audited.outboxId) {
      throw new TenantRollbackError(audited.message ?? "Audit event not recorded");
    }
    return audited.outboxId;
  }

  async createChatbot(
    params: Schemas.CreateChatbotApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.CreateChatbotApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.CreateChatbotApiResponse>> => {
        const result = await this.dal.createChatbot(tx, {
          companyId: params.companyId,
          name: params.chatbot.name,
        });
        if (!result.isSuccess || !result.chatbot) return this.withChatbotResponse(result);
        const outboxId = await this.audit(
          tx,
          params,
          result.chatbot,
          Schemas.AuditEntityActionEnum.Created,
        );
        return { ...this.withChatbotResponse(result), outboxIds: [outboxId] };
      },
    );
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

  // DEV_NOTE: Audited by what changed against the row before: a new name is Updated, a new status Paused / Resumed
  // (both = two rows); a save that changes nothing records nothing
  async updateChatbot(
    params: Schemas.UpdateChatbotApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateChatbotApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateChatbotApiResponse>> => {
        const before = await this.dal.getChatbotDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
        });
        if (!before.isSuccess || !before.chatbot) return this.withChatbotResponse(before);

        const result = await this.dal.updateChatbot(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          name: params.chatbot.name ?? null,
          status: params.chatbot.status ?? null,
        });
        if (!result.isSuccess || !result.chatbot) return this.withChatbotResponse(result);
        const after = result.chatbot;

        const actions: Schemas.AuditEntityActionEnum[] = [];
        if (after.name !== before.chatbot.name) actions.push(Schemas.AuditEntityActionEnum.Updated);
        if (after.status !== before.chatbot.status) {
          actions.push(
            after.status === Schemas.ChatbotStatusIntEnum.Paused
              ? Schemas.AuditEntityActionEnum.Paused
              : Schemas.AuditEntityActionEnum.Resumed,
          );
        }
        const outboxIds: string[] = [];
        for (const action of actions) {
          outboxIds.push(await this.audit(tx, params, after, action));
        }
        return { ...this.withChatbotResponse(result), outboxIds };
      },
    );
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
