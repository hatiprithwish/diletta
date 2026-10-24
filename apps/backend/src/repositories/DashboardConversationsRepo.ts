import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import ToolCallsDAL from "@/data-access-layer/ToolCallsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import ConversationTranscriptProvider from "@/providers/conversationTranscript";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

type ResolvedFilter =
  | { isSuccess: true; filter: Schemas.ConversationsFilterDALRequest }
  | { isSuccess: false; message?: string; isNotFound?: boolean };

// DEV_NOTE: Tenant Repo — the dashboard's Conversations page (M4-4): the list, its export and one conversation's
// transcript, each one read-only withTenant. botId and configId are public ids resolved in the company (unknown → 404).
// Rows reach the client as public ids only; the transcript never carries a tool call's args or a change's values
// (encrypted, never decrypted here) and its costs are the company key's spend (ConversationTranscriptProvider).
export default class DashboardConversationsRepo {
  private db: NodePgDatabase;
  private conversationsDal: ConversationsDAL;
  private messagesDal: MessagesDAL;
  private toolCallsDal: ToolCallsDAL;
  private modelCallsDal: ModelCallsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private chatbotsDal: ChatbotsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.conversationsDal = new ConversationsDAL();
    this.messagesDal = new MessagesDAL();
    this.toolCallsDal = new ToolCallsDAL();
    this.modelCallsDal = new ModelCallsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.chatbotsDal = new ChatbotsDAL();
  }

  // DEV_NOTE: Status Enum Pattern — int + label for status, outcome ("In progress" while it has none) and rating. A
  // purged conversation keeps its row but not its title.
  private toListItem(row: Schemas.DashboardConversationRow): Schemas.ConversationListItem {
    const isContentPurged = row.contentPurgedAt !== null;
    return {
      publicId: row.publicId,
      userName: row.userName,
      title: isContentPurged ? null : row.title,
      isContentPurged,
      conversationStatus: row.status,
      conversationStatusLabel: Schemas.CONVERSATION_STATUS_LABEL_MAP[row.status],
      outcome: row.outcome,
      outcomeLabel:
        row.outcome === null
          ? Schemas.CONVERSATION_IN_PROGRESS_LABEL
          : Schemas.CONVERSATION_OUTCOME_LABEL_MAP[row.outcome],
      turnCount: row.turnCount,
      chatbotName: row.chatbotName,
      configVersion: row.configVersion,
      rating: row.rating,
      ratingLabel: row.rating === null ? null : Schemas.FEEDBACK_RATING_LABEL_MAP[row.rating],
      createdAt: row.createdAt.toISOString(),
      lastActivityAt: row.lastActivityAt.toISOString(),
    };
  }

  async getConversations(
    params: Schemas.GetConversationsApiRequest & { companyId: string },
  ): Promise<Schemas.GetConversationsApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetConversationsApiResponse> => {
        const options = await this.chatbotConfigsDal.getChatbotConfigOptions(tx, { companyId });
        if (!options.isSuccess) return { isSuccess: false, message: options.message };
        const configOptions = options.options ?? [];

        const resolved = await this.resolveFilter(tx, params, configOptions);
        if (!resolved.isSuccess) return resolved;
        const { filter } = resolved;

        const page = await this.conversationsDal.getDashboardConversations(tx, {
          ...filter,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.ConversationSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess) return { isSuccess: false, message: page.message };

        const { tab: _tab, ...countFilter } = filter;
        const counted = await this.conversationsDal.getDashboardConversationsCount(tx, countFilter);
        if (!counted.isSuccess || !counted.tabCounts) {
          return { isSuccess: false, message: counted.message };
        }
        const { tabCounts } = counted;

        return {
          isSuccess: true,
          message: "Conversations fetched successfully",
          conversations: (page.conversations ?? []).map((row) => this.toListItem(row)),
          totalRecords: tabCounts[filter.tab],
          tabCounts,
          configOptions: configOptions.map((option) => ({
            publicId: option.publicId,
            chatbotName: option.chatbotName,
            configVersion: option.configVersion,
          })),
        };
      },
    );
  }

  // DEV_NOTE: The list under the same filters, newest first, at most CONVERSATIONS_EXPORT_MAX_ROWS rows: one more is
  // read to tell whether there were more (isTruncated). The client turns it into a file.
  async exportConversations(
    params: Schemas.ExportConversationsApiRequest & { companyId: string },
  ): Promise<Schemas.ExportConversationsApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.ExportConversationsApiResponse> => {
        const options = await this.chatbotConfigsDal.getChatbotConfigOptions(tx, { companyId });
        if (!options.isSuccess) return { isSuccess: false, message: options.message };
        const resolved = await this.resolveFilter(tx, params, options.options ?? []);
        if (!resolved.isSuccess) return resolved;

        const rows = await this.conversationsDal.getDashboardConversations(tx, {
          ...resolved.filter,
          pageNo: 1,
          pageSize: Schemas.CONVERSATIONS_EXPORT_MAX_ROWS + 1,
          sortColumn: Schemas.ConversationSortColumn.CreatedAt,
          sortDirection: Schemas.SortDirection.Desc,
        });
        if (!rows.isSuccess) return { isSuccess: false, message: rows.message };
        const conversations = rows.conversations ?? [];

        return {
          isSuccess: true,
          message: "Conversations exported successfully",
          conversations: conversations
            .slice(0, Schemas.CONVERSATIONS_EXPORT_MAX_ROWS)
            .map((row) => this.toListItem(row)),
          isTruncated: conversations.length > Schemas.CONVERSATIONS_EXPORT_MAX_ROWS,
        };
      },
    );
  }

  // DEV_NOTE: One conversation's detail card: its row, then its messages, tool calls and spend per turn, put into
  // turns by ConversationTranscriptProvider. An unknown or another company's conversation is 404.
  async getConversation(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetConversationApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetConversationApiResponse> => {
        const found = await this.conversationsDal.getDashboardConversation(tx, params);
        if (!found.isSuccess || !found.conversation) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const row = found.conversation;
        const scope = { companyId, conversationId: row.id };

        const messages = await this.messagesDal.listConversationMessages(tx, scope);
        if (!messages.isSuccess) return { isSuccess: false, message: messages.message };
        const toolCalls = await this.toolCallsDal.listConversationToolCalls(tx, scope);
        if (!toolCalls.isSuccess) return { isSuccess: false, message: toolCalls.message };
        const turnCosts = await this.modelCallsDal.getConversationTurnCosts(tx, scope);
        if (!turnCosts.isSuccess) return { isSuccess: false, message: turnCosts.message };

        return {
          isSuccess: true,
          message: "Conversation fetched successfully",
          conversation: {
            ...this.toListItem(row),
            isFlagged: row.isFlagged,
            ...ConversationTranscriptProvider.buildTranscript({
              messages: messages.messages ?? [],
              toolCalls: toolCalls.toolCalls ?? [],
              turnCosts: turnCosts.turnCosts ?? [],
            }),
          },
        };
      },
    );
  }

  // DEV_NOTE: The client's public ids → the DAL's internal ids, within the company: botId through the chatbot, configId
  // through the Config filter's own choices (an unknown one, or one never published, is 404)
  private async resolveFilter(
    tx: Tx,
    params: Schemas.ConversationsFilterApiRequest & { companyId: string },
    configOptions: Schemas.ChatbotConfigOptionRow[],
  ): Promise<ResolvedFilter> {
    let chatbotId: string | null = null;
    if (params.botId !== undefined) {
      const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
        companyId: params.companyId,
        publicId: params.botId,
      });
      if (!chatbot.isSuccess || !chatbot.chatbot) {
        return { isSuccess: false, message: chatbot.message, isNotFound: chatbot.isNotFound };
      }
      chatbotId = chatbot.chatbot.id;
    }

    let chatbotConfigId: string | null = null;
    if (params.configId !== undefined) {
      const config = configOptions.find((option) => option.publicId === params.configId);
      if (!config)
        return { isSuccess: false, message: "Chatbot config not found", isNotFound: true };
      chatbotConfigId = config.id;
    }

    return {
      isSuccess: true,
      filter: {
        companyId: params.companyId,
        tab: params.tab ?? Schemas.ConversationListTabEnum.All,
        outcome: params.outcome ?? null,
        chatbotConfigId,
        chatbotId,
      },
    };
  }
}
