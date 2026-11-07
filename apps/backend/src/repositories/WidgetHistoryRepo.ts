import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The widget's history (Your chats): the signed-in host user's own chats with this chatbot, and one of them
// read back. The widget route calls it after WidgetAuthRepo.authenticate, so the identity (company, chatbot, host user)
// comes from the verified token, never the client. It reads only, from the read model (messages), so a chat that has
// ended is never brought back to life: its Durable Object is not woken, and an open one is picked up by the socket as
// before. A user with no chatbot_users row yet has no chats; nothing is created.
export default class WidgetHistoryRepo {
  private db: NodePgDatabase;
  private conversationsDal: ConversationsDAL;
  private messagesDal: MessagesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.conversationsDal = new ConversationsDAL();
    this.messagesDal = new MessagesDAL();
  }

  async getConversations(params: {
    identity: Schemas.WidgetIdentity;
    pageNo: number | null;
  }): Promise<Schemas.WidgetConversationsResponse> {
    const scope = this.scope(params.identity);
    const pageNo = params.pageNo ?? Constants.DEFAULT_PAGE_NO;

    return await withTenant(
      this.db,
      scope.companyId,
      async (tx): Promise<Schemas.WidgetConversationsResponse> => {
        const listed = await this.conversationsDal.getWidgetConversations(tx, {
          ...scope,
          pageNo,
          pageSize: Schemas.WIDGET_HISTORY_PAGE_SIZE,
        });
        if (!listed.isSuccess) return { isSuccess: false, message: listed.message };
        const counted = await this.conversationsDal.getWidgetConversationsCount(tx, scope);
        if (!counted.isSuccess) return { isSuccess: false, message: counted.message };

        return {
          isSuccess: true,
          message: "Widget conversations fetched successfully",
          conversations: (listed.conversations ?? []).map((row) => this.toListItem(row)),
          totalRecords: counted.totalRecords ?? 0,
        };
      },
    );
  }

  async getConversation(params: {
    identity: Schemas.WidgetIdentity;
    publicId: string;
  }): Promise<Schemas.WidgetConversationResponse> {
    const scope = this.scope(params.identity);

    return await withTenant(
      this.db,
      scope.companyId,
      async (tx): Promise<Schemas.WidgetConversationResponse> => {
        const found = await this.conversationsDal.getWidgetConversation(tx, {
          ...scope,
          publicId: params.publicId,
        });
        if (!found.isSuccess || !found.conversation) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const row = found.conversation;

        const listed = await this.messagesDal.listConversationMessages(tx, {
          companyId: scope.companyId,
          conversationId: row.id,
        });
        if (!listed.isSuccess) return { isSuccess: false, message: listed.message };

        return {
          isSuccess: true,
          message: "Widget conversation fetched successfully",
          conversation: {
            ...this.toListItem(row),
            messages: this.toPastMessages(listed.messages ?? []),
          },
        };
      },
    );
  }

  private scope(identity: Schemas.WidgetIdentity) {
    return {
      companyId: identity.companyId,
      chatbotId: identity.chatbotId,
      hostUserId: identity.hostUserId,
    };
  }

  private toListItem(row: Schemas.WidgetConversationRow): Schemas.WidgetConversationListItem {
    return {
      publicId: row.publicId,
      title: row.title,
      isOpen: row.status === Schemas.ConversationStatusIntEnum.Open,
      lastActivityAt: row.lastActivityAt.toISOString(),
    };
  }

  // DEV_NOTE: The user's messages and the replies, as the widget shows them. content is jsonb (read untyped): a row that
  // doesn't parse, has no text, or isn't a user message or a reply is left out.
  private toPastMessages(rows: Schemas.TranscriptMessageRow[]): Schemas.WidgetPastMessage[] {
    return rows.flatMap((row): Schemas.WidgetPastMessage[] => {
      const role =
        row.role === Schemas.MessageRoleIntEnum.User
          ? "user"
          : row.role === Schemas.MessageRoleIntEnum.Assistant
            ? "assistant"
            : null;
      const content = Schemas.ZMessageContent.safeParse(row.content);
      if (!role || !content.success || content.data.text.trim().length === 0) return [];
      return [
        {
          publicId: row.publicId,
          role,
          text: content.data.text,
          citations: role === "assistant" ? (content.data.citations ?? []) : [],
        },
      ];
    });
  }
}
