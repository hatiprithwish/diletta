import { and, asc, count, desc, eq, exists, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { EmptyRelations, SQL } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  activityLog,
  changeRequests,
  chatbotConfigs,
  chatbotUsers,
  chatbots,
  conversations,
  evalCases,
  evalRuns,
  feedback,
  messages,
  modelCalls,
  qualityIssues,
  toolCalls,
} from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

const EVAL_ATTEMPT_INDEX = "UNQ_conversations_eval_run_id_eval_case_id_eval_attempt";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). title is chat content (the first user
// message), so it stays out of every log. An eval attempt's conversation (eval_run_id set, M5-2) is left out of every
// dashboard read and rollup: it is a test of a config, not a user's chat.
export default class ConversationsDAL {
  async createConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateConversationDALRequest,
  ) {
    const response: Schemas.ConversationDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing
      const chatbotConditions = [
        eq(chatbots.id, params.chatbotId),
        eq(chatbots.companyId, params.companyId),
      ];
      const [chatbot] = await tx
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(...chatbotConditions))
        .limit(1);
      if (!chatbot) {
        const message = "Chatbot not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateConversation,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const chatbotUserConditions = [
        eq(chatbotUsers.id, params.chatbotUserId),
        eq(chatbotUsers.companyId, params.companyId),
      ];
      const [chatbotUser] = await tx
        .select({ id: chatbotUsers.id })
        .from(chatbotUsers)
        .where(and(...chatbotUserConditions))
        .limit(1);
      if (!chatbotUser) {
        const message = "Chatbot user not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateConversation,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const evalAttempt = params.eval;
      if (evalAttempt) {
        const runConditions = [
          eq(evalRuns.id, evalAttempt.evalRunId),
          eq(evalRuns.companyId, params.companyId),
        ];
        const [run] = await tx
          .select({ id: evalRuns.id })
          .from(evalRuns)
          .where(and(...runConditions))
          .limit(1);
        if (!run) {
          const message = "Eval run not found";
          AppLogger.error({
            category: Schemas.LogCategory.DAL,
            action: Schemas.LogAction.CreateConversation,
            message,
            metadata: params,
          });
          response.message = message;
          return response;
        }
      }
      if (evalAttempt) {
        // DEV_NOTE: The company's own case or a platform one (company_id null)
        const caseConditions = [
          eq(evalCases.id, evalAttempt.evalCaseId),
          or(eq(evalCases.companyId, params.companyId), isNull(evalCases.companyId)),
        ];
        const [evalCase] = await tx
          .select({ id: evalCases.id })
          .from(evalCases)
          .where(and(...caseConditions))
          .limit(1);
        if (!evalCase) {
          const message = "Eval case not found";
          AppLogger.error({
            category: Schemas.LogCategory.DAL,
            action: Schemas.LogAction.CreateConversation,
            message,
            metadata: params,
          });
          response.message = message;
          return response;
        }
      }
      if (evalAttempt?.chatbotConfigId) {
        const configConditions = [
          eq(chatbotConfigs.id, evalAttempt.chatbotConfigId),
          eq(chatbotConfigs.chatbotId, params.chatbotId),
          eq(chatbotConfigs.companyId, params.companyId),
        ];
        const [config] = await tx
          .select({ id: chatbotConfigs.id })
          .from(chatbotConfigs)
          .where(and(...configConditions))
          .limit(1);
        if (!config) {
          const message = "Chatbot config not found";
          AppLogger.error({
            category: Schemas.LogCategory.DAL,
            action: Schemas.LogAction.CreateConversation,
            message,
            metadata: params,
          });
          response.message = message;
          return response;
        }
      }

      const [conversationResponse] = await tx
        .insert(conversations)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          chatbotUserId: params.chatbotUserId,
          evalRunId: evalAttempt?.evalRunId ?? null,
          evalCaseId: evalAttempt?.evalCaseId ?? null,
          evalAttempt: evalAttempt?.evalAttempt ?? null,
          chatbotConfigId: evalAttempt?.chatbotConfigId ?? null,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Conversation created successfully";
      response.conversation = conversationResponse;
    } catch (error) {
      if (Utility.isUniqueViolation(error, EVAL_ATTEMPT_INDEX)) {
        const message = "This eval attempt already ran";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateConversation,
          message,
          metadata: params,
        });
        response.message = message;
        response.isConflict = true;
        return response;
      }
      const message = "Unknown error in creating conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateConversation,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getConversationDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindConversationDALRequest,
  ) {
    const response: Schemas.ConversationDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(conversations.publicId, params.publicId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(and(...conditions))
        .limit(1);

      if (!conversation) {
        const message = "Conversation not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetConversationDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Conversation fetched successfully";
      response.conversation = conversation;
    } catch (error) {
      const message = "Unknown error in fetching conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetConversationDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: No DB foreign keys — the activity row must exist in the company (it is a root: no parent of its own)
  async setConversationRootLog(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetConversationRootLogDALRequest,
  ) {
    const conditions = [
      eq(activityLog.id, params.rootLogId),
      eq(activityLog.companyId, params.companyId),
    ];
    const missing = await this.findMissing(
      tx,
      Schemas.LogAction.SetConversationRootLog,
      params,
      "Activity log not found",
      async () =>
        await tx
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(...conditions))
          .limit(1),
    );
    if (missing) return missing;
    return await this.update(tx, params, Schemas.LogAction.SetConversationRootLog, {
      rootLogId: params.rootLogId,
    });
  }

  // DEV_NOTE: No DB foreign keys — the config must exist in the company and belong to the conversation's chatbot
  async setConversationConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetConversationConfigDALRequest,
  ) {
    const conditions = [
      eq(chatbotConfigs.id, params.chatbotConfigId),
      eq(chatbotConfigs.companyId, params.companyId),
      eq(chatbotConfigs.chatbotId, conversations.chatbotId),
      eq(conversations.publicId, params.publicId),
      eq(conversations.companyId, params.companyId),
    ];
    const missing = await this.findMissing(
      tx,
      Schemas.LogAction.SetConversationConfig,
      params,
      "Chatbot config not found",
      async () =>
        await tx
          .select({ id: chatbotConfigs.id })
          .from(chatbotConfigs)
          .innerJoin(conversations, eq(conversations.chatbotId, chatbotConfigs.chatbotId))
          .where(and(...conditions))
          .limit(1),
    );
    if (missing) return missing;
    return await this.update(tx, params, Schemas.LogAction.SetConversationConfig, {
      chatbotConfigId: params.chatbotConfigId,
    });
  }

  // DEV_NOTE: The title is set once, from the first turn: COALESCE keeps one already stored
  async touchConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.TouchConversationDALRequest,
  ) {
    const { title: _title, ...metadata } = params;
    return await this.update(tx, metadata, Schemas.LogAction.TouchConversation, {
      lastActivityAt: new Date(),
      title:
        params.title === null ? undefined : sql`COALESCE(${conversations.title}, ${params.title})`,
    });
  }

  // DEV_NOTE: Only an Open conversation closes; isNotFound when it is gone or already closed
  async closeConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CloseConversationDALRequest,
  ) {
    return await this.update(
      tx,
      params,
      Schemas.LogAction.CloseConversation,
      {
        status: Schemas.ConversationStatusIntEnum.Closed,
        outcome: params.outcome,
      },
      eq(conversations.status, Schemas.ConversationStatusIntEnum.Open),
    );
  }

  // DEV_NOTE: A reference check before an update: the failed response when lookup finds no row (or fails), else null
  private async findMissing(
    tx: NodePgTransaction<EmptyRelations>,
    action: Schemas.LogAction,
    params: Schemas.FindConversationDALRequest,
    notFoundMessage: string,
    lookup: () => Promise<{ id: string }[]>,
  ): Promise<Schemas.ConversationDALResponse | null> {
    try {
      const [row] = await lookup();
      if (row) return null;
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action,
        message: notFoundMessage,
        metadata: params,
      });
      return { isSuccess: false, message: notFoundMessage };
    } catch (error) {
      const message = "Unknown error in checking a conversation reference";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action,
        message,
        error,
        metadata: params,
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: One conversation found by publicId within its company (plus an optional extra condition); updatedAt is
  // set here. isNotFound when no row matched.
  private async update(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindConversationDALRequest,
    action: Schemas.LogAction,
    values: PgUpdateSetSource<typeof conversations>,
    extraCondition?: ReturnType<typeof eq>,
  ) {
    const response: Schemas.ConversationDALResponse = { isSuccess: false };
    const metadata = { ...params };

    try {
      const conditions = [
        eq(conversations.publicId, params.publicId),
        eq(conversations.companyId, params.companyId),
      ];
      if (extraCondition) conditions.push(extraCondition);
      const [conversationResponse] = await tx
        .update(conversations)
        .set({ ...values, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!conversationResponse) {
        const message = "Conversation not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Conversation updated successfully";
      response.conversation = conversationResponse;
    } catch (error) {
      const message = "Unknown error in updating conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Activity rollups (M4-2): the conversations started in [start, end), per chatbot and outcome (null while
  // open). The rollup counts each by its start day, the one day a conversation keeps.
  async getConversationRollupGroups(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ActivityRollupWindowDALRequest,
  ) {
    const response: Schemas.ConversationRollupGroupsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(conversations.companyId, params.companyId),
        gte(conversations.createdAt, params.start),
        lt(conversations.createdAt, params.end),
        isNull(conversations.evalRunId),
      ];
      const groups = await tx
        .select({
          chatbotId: conversations.chatbotId,
          outcome: conversations.outcome,
          count: count(),
        })
        .from(conversations)
        .where(and(...conditions))
        .groupBy(conversations.chatbotId, conversations.outcome);

      response.isSuccess = true;
      response.message = "Conversation rollup groups fetched successfully";
      response.groups = groups;
    } catch (error) {
      const message = "Unknown error in fetching conversation rollup groups";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetConversationRollupGroups,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // ─── Dashboard (M4-4): the Conversations page ─────────────────────────────

  // DEV_NOTE: One conversation as the dashboard lists it. The correlated subqueries read only this conversation's rows
  // (every reference column is indexed) and filter on companyId too:
  //   turnCount: distinct turn ids across its messages, tool calls and spend model calls (Workers AI rows are left out,
  //     as in the turn costs), so it matches the turns of the transcript.
  //   rating: Down if any reply was rated down, else Up if any was rated, else null.
  //   isFlagged: an admin issue on it is still open.
  private dashboardSelection(companyId: string) {
    return {
      id: conversations.id,
      publicId: conversations.publicId,
      status: conversations.status,
      outcome: conversations.outcome,
      title: conversations.title,
      contentPurgedAt: conversations.contentPurgedAt,
      createdAt: conversations.createdAt,
      lastActivityAt: conversations.lastActivityAt,
      rootLogId: conversations.rootLogId,
      userName: chatbotUsers.displayName,
      chatbotName: chatbots.name,
      configVersion: chatbotConfigs.configVersion,
      turnCount: sql<number>`(
        select count(*) from (
          select ${messages.turnId} from ${messages}
          where ${messages.conversationId} = ${conversations.id} and ${messages.companyId} = ${companyId}
          union
          select ${toolCalls.turnId} from ${toolCalls}
          where ${toolCalls.conversationId} = ${conversations.id} and ${toolCalls.companyId} = ${companyId}
          union
          select ${modelCalls.turnId} from ${modelCalls}
          where ${modelCalls.conversationId} = ${conversations.id} and ${modelCalls.companyId} = ${companyId}
            and ${modelCalls.turnId} is not null
            and ${modelCalls.provider} <> ${Schemas.PlatformModelProviderEnum.WorkersAi}
        ) as turns
      )`.mapWith(Number),
      rating: sql<Schemas.FeedbackRatingIntEnum | null>`(
        select case
          when bool_or(${feedback.rating} = ${Schemas.FeedbackRatingIntEnum.Down}) then ${Schemas.FeedbackRatingIntEnum.Down}::int
          when count(*) > 0 then ${Schemas.FeedbackRatingIntEnum.Up}::int
        end
        from ${feedback}
        inner join ${messages} on ${messages.id} = ${feedback.messageId}
        where ${messages.conversationId} = ${conversations.id} and ${messages.companyId} = ${companyId}
          and ${feedback.companyId} = ${companyId}
      )`.mapWith(Number),
      isFlagged: sql<boolean>`exists (
        select 1 from ${qualityIssues}
        where ${qualityIssues.conversationId} = ${conversations.id} and ${qualityIssues.companyId} = ${companyId}
          and ${qualityIssues.source} = ${Schemas.QualityIssueSourceIntEnum.Admin}
          and ${qualityIssues.status} = ${Schemas.QualityIssueStatusIntEnum.Open}
      )`,
    };
  }

  // DEV_NOTE: The user, chatbot and config of a conversation, left joined: there are no DB foreign keys, so a row whose
  // reference is gone still lists
  private dashboardQuery(tx: NodePgTransaction<EmptyRelations>, companyId: string) {
    const userJoinConditions = [
      eq(chatbotUsers.id, conversations.chatbotUserId),
      eq(chatbotUsers.companyId, conversations.companyId),
    ];
    const chatbotJoinConditions = [
      eq(chatbots.id, conversations.chatbotId),
      eq(chatbots.companyId, conversations.companyId),
    ];
    const configJoinConditions = [
      eq(chatbotConfigs.id, conversations.chatbotConfigId),
      eq(chatbotConfigs.companyId, conversations.companyId),
    ];
    return tx
      .select(this.dashboardSelection(companyId))
      .from(conversations)
      .leftJoin(chatbotUsers, and(...userJoinConditions))
      .leftJoin(chatbots, and(...chatbotJoinConditions))
      .leftJoin(chatbotConfigs, and(...configJoinConditions));
  }

  // DEV_NOTE: The list's filters but the tab, shared by the list and its counts
  private dashboardConditions(params: Schemas.CountDashboardConversationsDALRequest): SQL[] {
    const conditions: SQL[] = [
      eq(conversations.companyId, params.companyId),
      isNull(conversations.evalRunId),
    ];
    if (params.chatbotId !== null) conditions.push(eq(conversations.chatbotId, params.chatbotId));
    if (params.chatbotConfigId !== null) {
      conditions.push(eq(conversations.chatbotConfigId, params.chatbotConfigId));
    }
    if (params.outcome !== null) {
      const outcome = Schemas.CONVERSATION_OUTCOME_FILTER_MAP[params.outcome];
      conditions.push(
        outcome === null ? isNull(conversations.outcome) : eq(conversations.outcome, outcome),
      );
    }
    return conditions;
  }

  // DEV_NOTE: A tab's condition (All has none). NeedsAttention: a change request that needs a person, or an open
  // quality issue; RatedDown: any reply rated down.
  private tabCondition(
    tx: NodePgTransaction<EmptyRelations>,
    companyId: string,
    tab: Schemas.ConversationListTabEnum,
  ): SQL | undefined {
    if (tab === Schemas.ConversationListTabEnum.NeedsAttention) {
      const changeConditions = [
        eq(changeRequests.conversationId, conversations.id),
        eq(changeRequests.companyId, companyId),
        eq(changeRequests.status, Schemas.ChangeRequestStatusIntEnum.NeedsHuman),
      ];
      const issueConditions = [
        eq(qualityIssues.conversationId, conversations.id),
        eq(qualityIssues.companyId, companyId),
        eq(qualityIssues.status, Schemas.QualityIssueStatusIntEnum.Open),
      ];
      return or(
        exists(
          tx
            .select({ one: sql`1` })
            .from(changeRequests)
            .where(and(...changeConditions)),
        ),
        exists(
          tx
            .select({ one: sql`1` })
            .from(qualityIssues)
            .where(and(...issueConditions)),
        ),
      );
    }

    if (tab === Schemas.ConversationListTabEnum.RatedDown) {
      const ratedDownConditions = [
        eq(messages.conversationId, conversations.id),
        eq(messages.companyId, companyId),
        eq(feedback.companyId, companyId),
        eq(feedback.rating, Schemas.FeedbackRatingIntEnum.Down),
      ];
      return exists(
        tx
          .select({ one: sql`1` })
          .from(feedback)
          .innerJoin(messages, eq(messages.id, feedback.messageId))
          .where(and(...ratedDownConditions)),
      );
    }

    return undefined;
  }

  async getDashboardConversations(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetDashboardConversationsDALRequest,
  ) {
    const response: Schemas.DashboardConversationsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.ConversationSortColumn.CreatedAt]: conversations.createdAt,
        [Schemas.ConversationSortColumn.LastActivityAt]: conversations.lastActivityAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const conditions = this.dashboardConditions(params);
      const tabCondition = this.tabCondition(tx, params.companyId, params.tab);
      if (tabCondition) conditions.push(tabCondition);
      const conversationsResponse = await this.dashboardQuery(tx, params.companyId)
        .where(and(...conditions))
        // DEV_NOTE: id breaks ties (same created_at), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(conversations.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Conversations fetched successfully";
      response.conversations = conversationsResponse;
    } catch (error) {
      const message = "Unknown error in listing conversations";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardConversations,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every tab's count in one read, under the same outcome, config and chatbot filters; totalRecords = All's
  async getDashboardConversationsCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountDashboardConversationsDALRequest,
  ) {
    const response: Schemas.ConversationTabCountsDALResponse = { isSuccess: false };

    try {
      const { NeedsAttention, RatedDown } = Schemas.ConversationListTabEnum;
      const [result] = await tx
        .select({
          all: count(),
          needsAttention:
            sql<number>`count(*) filter (where ${this.tabCondition(tx, params.companyId, NeedsAttention)})`.mapWith(
              Number,
            ),
          ratedDown:
            sql<number>`count(*) filter (where ${this.tabCondition(tx, params.companyId, RatedDown)})`.mapWith(
              Number,
            ),
        })
        .from(conversations)
        .where(and(...this.dashboardConditions(params)));

      response.isSuccess = true;
      response.message = "Conversations counted successfully";
      response.totalRecords = result?.all ?? 0;
      response.tabCounts = {
        [Schemas.ConversationListTabEnum.All]: result?.all ?? 0,
        [Schemas.ConversationListTabEnum.NeedsAttention]: result?.needsAttention ?? 0,
        [Schemas.ConversationListTabEnum.RatedDown]: result?.ratedDown ?? 0,
      };
    } catch (error) {
      const message = "Unknown error in counting conversations";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountDashboardConversations,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getDashboardConversation(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindConversationDALRequest,
  ) {
    const response: Schemas.DashboardConversationDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(conversations.publicId, params.publicId),
        eq(conversations.companyId, params.companyId),
        isNull(conversations.evalRunId),
      ];
      const [conversation] = await this.dashboardQuery(tx, params.companyId)
        .where(and(...conditions))
        .limit(1);

      if (!conversation) {
        const message = "Conversation not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetDashboardConversation,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Conversation fetched successfully";
      response.conversation = conversation;
    } catch (error) {
      const message = "Unknown error in fetching conversation";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardConversation,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The Bots table's Conversations column (M4-10): started since, per chatbot, one grouped read
  async getChatbotConversationCounts(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConversationCountsDALRequest,
  ) {
    const response: Schemas.ChatbotConversationCountsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(conversations.companyId, params.companyId),
        gte(conversations.createdAt, params.since),
        isNull(conversations.evalRunId),
      ];
      const counts = await tx
        .select({ chatbotId: conversations.chatbotId, conversationCount: count() })
        .from(conversations)
        .where(and(...conditions))
        .groupBy(conversations.chatbotId);

      response.isSuccess = true;
      response.message = "Chatbot conversation counts fetched successfully";
      response.counts = counts;
    } catch (error) {
      const message = "Unknown error in counting chatbot conversations";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotConversationCounts,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
