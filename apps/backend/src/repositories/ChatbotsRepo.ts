import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — owns the db client and opens one withTenant transaction per call.
// companyId is the internal companies.id, resolved server-side from the signed-in admin; never from the client.
export default class ChatbotsRepo {
  private db: NodePgDatabase;
  private dal: ChatbotsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private conversationsDal: ConversationsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChatbotsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.conversationsDal = new ConversationsDAL();
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
    entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.Chatbot>,
  ): Promise<string> {
    return await recordAuditOrRollback(tx, {
      companyId: params.companyId,
      actor: adminAuditActor(params.adminId),
      entityType: Schemas.AuditEntityTypeEnum.Chatbot,
      entityAction,
      entity: chatbot,
      label: chatbot.name,
    });
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
          isForUpdate: true,
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

        const actions: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.Chatbot>[] = [];
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

  // DEV_NOTE: Settings › Bots' table (M4-10): every chatbot with its live and open versions and its conversations over the last
  // CHATBOT_CONVERSATION_COUNT_DAYS days, three reads in one transaction
  async getChatbotSettingsRows(params: {
    companyId: string;
  }): Promise<Schemas.GetChatbotSettingsRowsApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetChatbotSettingsRowsApiResponse> => {
        const listed = await this.dal.getChatbots(tx, params);
        if (!listed.isSuccess || !listed.chatbots) {
          return { isSuccess: false, message: listed.message };
        }
        const heads = await this.chatbotConfigsDal.getChatbotConfigHeads(tx, params);
        if (!heads.isSuccess || !heads.heads) return { isSuccess: false, message: heads.message };
        const since = new Date(Date.now() - Schemas.CHATBOT_CONVERSATION_COUNT_DAYS * 86_400_000);
        const counted = await this.conversationsDal.getChatbotConversationCounts(tx, {
          companyId: params.companyId,
          since,
        });
        if (!counted.isSuccess || !counted.counts) {
          return { isSuccess: false, message: counted.message };
        }

        const headOf = (chatbotId: string, isLive: boolean): Schemas.ChatbotConfigHead | null => {
          const head = heads.heads?.find(
            (row) =>
              row.chatbotId === chatbotId &&
              (row.status === Schemas.ChatbotConfigStatusIntEnum.Published) === isLive,
          );
          return head ? { publicId: head.publicId, configVersion: head.configVersion } : null;
        };
        const countByChatbot = new Map(
          counted.counts.map((row) => [row.chatbotId, row.conversationCount]),
        );
        return {
          isSuccess: true,
          message: listed.message,
          chatbots: listed.chatbots.map((chatbot) => ({
            ...this.withStatusLabel(chatbot),
            liveConfig: headOf(chatbot.id, true),
            draftConfig: headOf(chatbot.id, false),
            conversationCount: countByChatbot.get(chatbot.id) ?? 0,
          })),
        };
      },
    );
  }

  async deleteChatbot(params: { companyId: string; publicId: string }) {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.deleteChatbot(tx, params);
    });
  }

  // DEV_NOTE: Transactional flow — clear the old default, then mark the new one, with its audit row (M4-10). Any failed
  // step throws TenantRollbackError so withTenant rolls back and the previous default stays in place. Making the default
  // chatbot the default again changes nothing and records nothing.
  async setDefaultChatbot(params: {
    companyId: string;
    publicId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.SetDefaultChatbotApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.SetDefaultChatbotApiResponse>> => {
        const before = await this.dal.getChatbotDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!before.isSuccess || !before.chatbot) return this.withChatbotResponse(before);
        if (before.chatbot.isDefault) return { ...this.withChatbotResponse(before), outboxIds: [] };

        const cleared = await this.dal.clearDefaultChatbot(tx, { companyId: params.companyId });
        if (!cleared.isSuccess) {
          throw new TenantRollbackError(cleared.message);
        }

        const result = await this.dal.markDefaultChatbot(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
        });
        if (!result.isSuccess || !result.chatbot) {
          throw new TenantRollbackError(result.message);
        }

        const outboxId = await this.audit(
          tx,
          params,
          result.chatbot,
          Schemas.AuditEntityActionEnum.MadeDefault,
        );
        return { ...this.withChatbotResponse(result), outboxIds: [outboxId] };
      },
    );
  }
}
