import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotUsersDAL from "@/data-access-layer/ChatbotUsersDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ConversationCheckProvider from "@/providers/conversationCheck";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: A turn whose conversation check fails: a conversation missing from its company is a server fault here
// (the DO only serves one the worker resolved)
const TURN_CONFIG_CHECK_FAILURE_MAP: Record<
  Schemas.ConversationCheckFailureEnum,
  Schemas.TurnConfigFailureEnum
> = {
  [Schemas.ConversationCheckFailureEnum.NotFound]: Schemas.TurnConfigFailureEnum.ServerError,
  [Schemas.ConversationCheckFailureEnum.ConversationClosed]:
    Schemas.TurnConfigFailureEnum.ConversationClosed,
  [Schemas.ConversationCheckFailureEnum.ChatbotUnavailable]:
    Schemas.TurnConfigFailureEnum.ChatbotUnavailable,
  [Schemas.ConversationCheckFailureEnum.ServerError]: Schemas.TurnConfigFailureEnum.ServerError,
};

// DEV_NOTE: Conversations (M2-2). The widget route calls startOrResume after WidgetAuthRepo.authenticate, before it
// forwards the upgrade to the Conversation DO, so the DO only ever serves a verified user its own conversation (and
// closeConversation when that upgrade then fails). The DO calls the rest: the turn's config (re-checking the
// conversation, chatbot and company as they are now, so pausing a chatbot or a company stops an open socket at its
// next message), the read model, and the auto-close. Every id is internal and comes from the verified identity or the session,
// never from the client; the client names a conversation only by publicId, and only one of its own.
export default class ConversationsRepo {
  private db: NodePgDatabase;
  private chatbotUsersDal: ChatbotUsersDAL;
  private conversationsDal: ConversationsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private messagesDal: MessagesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.chatbotUsersDal = new ChatbotUsersDAL();
    this.conversationsDal = new ConversationsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.messagesDal = new MessagesDAL();
  }

  // DEV_NOTE: The verified user's chatbot_users row (created on first visit, display name kept current), then either
  // their open conversation with this chatbot (conversationPublicId) or a new one with its conversation.started
  // critical event as the activity root. A conversation that is another user's, another chatbot's, another
  // company's, or closed answers NotFound, never which of them. The caller relays outboxId after the commit.
  async startOrResume(params: {
    identity: Schemas.WidgetIdentity;
    conversationPublicId: string | null;
  }): Promise<Schemas.StartConversationResponse> {
    const { identity } = params;
    const chatbotUser = await this.upsertChatbotUser(identity);
    if (!chatbotUser.isSuccess || !chatbotUser.chatbotUser) {
      return this.reject(
        Schemas.ConversationStartFailureEnum.ServerError,
        chatbotUser.message,
        identity,
      );
    }
    const chatbotUserId = chatbotUser.chatbotUser.id;

    const result: Schemas.StartConversationResponse = await withTenant(
      this.db,
      identity.companyId,
      async (tx) => {
        if (params.conversationPublicId !== null) {
          const found = await this.conversationsDal.getConversationDetails(tx, {
            companyId: identity.companyId,
            publicId: params.conversationPublicId,
          });
          if (!found.isSuccess || !found.conversation) {
            return {
              isSuccess: false,
              message: found.message,
              failure: found.isNotFound
                ? Schemas.ConversationStartFailureEnum.NotFound
                : Schemas.ConversationStartFailureEnum.ServerError,
            };
          }
          const { conversation } = found;
          const isTheirs =
            conversation.chatbotId === identity.chatbotId &&
            conversation.chatbotUserId === chatbotUserId &&
            conversation.status === Schemas.ConversationStatusIntEnum.Open;
          if (!isTheirs) {
            return {
              isSuccess: false,
              message: "Conversation is closed or not this user's",
              failure: Schemas.ConversationStartFailureEnum.NotFound,
            };
          }
          return {
            isSuccess: true,
            message: "Conversation resumed",
            session: this.toSession(identity, chatbotUserId, conversation),
            isNew: false,
          };
        }

        const created = await this.conversationsDal.createConversation(tx, {
          companyId: identity.companyId,
          chatbotId: identity.chatbotId,
          chatbotUserId,
        });
        if (!created.isSuccess || !created.conversation) {
          throw new TenantRollbackError(created.message);
        }
        const { conversation } = created;

        const event = await CriticalEventProvider.record(tx, {
          companyId: identity.companyId,
          actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
          actorId: chatbotUserId,
          entityType: "conversation",
          entityId: conversation.id,
          entityAction: "started",
          entityVersion: null,
          parentLogId: null,
          rootLogId: null,
          detail: { chatbotId: identity.chatbotId, connectionId: identity.connectionId },
          eventType: "conversation.started",
          dedupeKey: `conversation.started:${conversation.publicId}`,
        });
        if (!event.isSuccess || !event.activityLogId || !event.outboxId) {
          throw new TenantRollbackError(event.message);
        }

        const rooted = await this.conversationsDal.setConversationRootLog(tx, {
          companyId: identity.companyId,
          publicId: conversation.publicId,
          rootLogId: event.activityLogId,
        });
        if (!rooted.isSuccess || !rooted.conversation) {
          throw new TenantRollbackError(rooted.message);
        }

        return {
          isSuccess: true,
          message: "Conversation started",
          session: this.toSession(identity, chatbotUserId, rooted.conversation),
          isNew: true,
          outboxId: event.outboxId,
        };
      },
    );

    if (!result.isSuccess) {
      return this.reject(
        result.failure ?? Schemas.ConversationStartFailureEnum.ServerError,
        result.message,
        identity,
      );
    }
    return result;
  }

  // DEV_NOTE: The config this turn runs on, after checking the conversation, chatbot and company as they are now (the
  // socket may have opened long before): an open conversation, an active chatbot of an active company. Then the
  // chatbot's published config, read fresh every turn so a publish takes effect at the next one, loaded through
  // loadConfigSpec (upgraded, validated, platform defaults filled in); conversations.chatbot_config_id follows it.
  async loadTurnConfig(params: {
    session: Schemas.ConversationSession;
  }): Promise<Schemas.LoadTurnConfigResponse> {
    const { session } = params;
    const refuse = (failure: Schemas.TurnConfigFailureEnum, message?: string) => ({
      isSuccess: false,
      message,
      failure,
    });

    return await withTenant(this.db, session.companyId, async (tx) => {
      const checked = await ConversationCheckProvider.check(tx, session);
      if (!checked.isSuccess) {
        return refuse(TURN_CONFIG_CHECK_FAILURE_MAP[checked.failure], checked.message);
      }
      const { conversation, company } = checked;

      const published = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
        companyId: session.companyId,
        chatbotId: session.chatbotId,
      });
      if (!published.isSuccess || !published.chatbotConfig) {
        return published.isNotFound
          ? refuse(Schemas.TurnConfigFailureEnum.NoPublishedConfig, published.message)
          : refuse(Schemas.TurnConfigFailureEnum.ServerError, published.message);
      }
      const { chatbotConfig } = published;

      const loaded = Schemas.loadConfigSpec({
        schemaVersion: chatbotConfig.schemaVersion,
        body: chatbotConfig.body,
      });
      if (!loaded.isSuccess || !loaded.spec) {
        AppLogger.error({
          category: Schemas.LogCategory.Conversation,
          action: Schemas.LogAction.LoadTurnConfig,
          message: loaded.message ?? "Published config could not be loaded",
          metadata: {
            companyId: session.companyId,
            chatbotId: session.chatbotId,
            chatbotConfigId: chatbotConfig.id,
            schemaVersion: chatbotConfig.schemaVersion,
          },
        });
        return refuse(Schemas.TurnConfigFailureEnum.ServerError, loaded.message);
      }

      if (conversation.chatbotConfigId !== chatbotConfig.id) {
        const updated = await this.conversationsDal.setConversationConfig(tx, {
          companyId: session.companyId,
          publicId: session.conversationPublicId,
          chatbotConfigId: chatbotConfig.id,
        });
        if (!updated.isSuccess) {
          throw new TenantRollbackError(updated.message);
        }
      }

      return {
        isSuccess: true,
        message: "Turn config loaded",
        spec: loaded.spec,
        chatbotConfigId: chatbotConfig.id,
        isReadOnly: company.isReadOnly,
      };
    });
  }

  // DEV_NOTE: One turn into the read model, in one transaction: its messages (already-stored ones skipped, so a retry
  // is safe), last_activity_at, and the title while it is unset
  async recordTurn(params: {
    session: Schemas.ConversationSession;
    turnId: string;
    messages: Schemas.TurnMessage[];
    title: string | null;
  }): Promise<Schemas.ApiResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const created = await this.messagesDal.createMessages(tx, {
        companyId: session.companyId,
        conversationId: session.conversationId,
        turnId: params.turnId,
        messages: params.messages,
      });
      if (!created.isSuccess) {
        throw new TenantRollbackError(created.message);
      }

      const touched = await this.conversationsDal.touchConversation(tx, {
        companyId: session.companyId,
        publicId: session.conversationPublicId,
        title: params.title,
      });
      if (!touched.isSuccess) {
        throw new TenantRollbackError(touched.message);
      }

      return { isSuccess: true, message: "Turn recorded" };
    });
  }

  // DEV_NOTE: The auto-close, and the widget route closing a conversation it created whose DO upgrade then failed. A
  // conversation already closed stays as it is (isNotFound).
  async closeConversation(params: {
    session: Schemas.ConversationSession;
    outcome: Schemas.ConversationOutcomeIntEnum;
  }): Promise<Schemas.ApiResponse> {
    const { session } = params;
    return await withTenant(this.db, session.companyId, async (tx) => {
      const { conversation: _conversation, ...result } =
        await this.conversationsDal.closeConversation(tx, {
          companyId: session.companyId,
          publicId: session.conversationPublicId,
          outcome: params.outcome,
        });
      return result;
    });
  }

  // DEV_NOTE: Its own transaction, before the conversation's: two first connects of one user can race, and the loser
  // of the insert (unique host_user_id) reads the winner's row instead of failing the transaction it would abort
  private async upsertChatbotUser(
    identity: Schemas.WidgetIdentity,
  ): Promise<Schemas.ChatbotUserDALResponse> {
    const find = async () =>
      await withTenant(this.db, identity.companyId, async (tx) => {
        return await this.chatbotUsersDal.getChatbotUserDetails(tx, {
          companyId: identity.companyId,
          hostUserId: identity.hostUserId,
        });
      });

    const found: Schemas.ChatbotUserDALResponse = await find();
    if (found.isSuccess && found.chatbotUser) {
      const hasNewName =
        identity.displayName !== null && identity.displayName !== found.chatbotUser.displayName;
      if (!hasNewName) return found;
      return await withTenant(this.db, identity.companyId, async (tx) => {
        return await this.chatbotUsersDal.updateChatbotUser(tx, {
          companyId: identity.companyId,
          hostUserId: identity.hostUserId,
          displayName: identity.displayName,
        });
      });
    }
    if (!found.isNotFound) return found;

    const created: Schemas.ChatbotUserDALResponse = await withTenant(
      this.db,
      identity.companyId,
      async (tx) => {
        return await this.chatbotUsersDal.createChatbotUser(tx, {
          companyId: identity.companyId,
          hostUserId: identity.hostUserId,
          displayName: identity.displayName,
        });
      },
    );
    return created.isSuccess ? created : await find();
  }

  private toSession(
    identity: Schemas.WidgetIdentity,
    chatbotUserId: string,
    conversation: Schemas.Conversation,
  ): Schemas.ConversationSession {
    return {
      companyId: identity.companyId,
      chatbotId: identity.chatbotId,
      chatbotPublicId: identity.chatbotPublicId,
      chatbotName: identity.chatbotName,
      chatbotUserId,
      conversationId: conversation.id,
      conversationPublicId: conversation.publicId,
    };
  }

  private reject(
    failure: Schemas.ConversationStartFailureEnum,
    message: string | undefined,
    identity: Schemas.WidgetIdentity,
  ): Schemas.StartConversationResponse {
    const entry = {
      category: Schemas.LogCategory.Conversation,
      action: Schemas.LogAction.StartConversation,
      message: message ?? "Conversation could not be started",
      metadata: { companyId: identity.companyId, chatbotId: identity.chatbotId },
    };
    if (failure === Schemas.ConversationStartFailureEnum.ServerError) {
      AppLogger.error(entry);
    } else {
      AppLogger.warn(entry);
    }
    return { isSuccess: false, message: entry.message, failure };
  }
}
