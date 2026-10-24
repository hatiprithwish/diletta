import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { EmptyRelations, SQL } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  admins,
  changeRequests,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  evalCases,
  feedback,
  messages,
  qualityIssues,
} from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). System issues come from the model router's
// key-failure path (M2-3), user issues from a thumbs-down (M2-8), admin issues from a flag on the Conversations
// page (M4-4). The Quality page (M4-6) lists, reads, triages and closes them.
export default class QualityIssuesDAL {
  // DEV_NOTE: Transaction-scoped advisory lock on (company, issue type), held until the Repo's transaction ends.
  // Two calls that hit the same failure at once take turns, so the second sees the first one's open issue instead
  // of opening a duplicate (there is no unique index to catch it: dismissed and fixed issues of the same type stay).
  async lockOpenSystemQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindOpenSystemQualityIssueDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKey = `quality_issue:system:${params.companyId}:${params.issueType}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      response.isSuccess = true;
      response.message = "Open system quality issue locked successfully";
    } catch (error) {
      const message = "Unknown error in locking open system quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockOpenSystemQualityIssue,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The oldest open system issue of the type, if any. isSuccess with no qualityIssue = none open.
  async getOpenSystemQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindOpenSystemQualityIssueDALRequest,
  ) {
    const response: Schemas.QualityIssueDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(qualityIssues.companyId, params.companyId),
        eq(qualityIssues.source, Schemas.QualityIssueSourceIntEnum.System),
        eq(qualityIssues.status, Schemas.QualityIssueStatusIntEnum.Open),
        eq(qualityIssues.issueType, params.issueType),
      ];
      const [qualityIssue] = await tx
        .select()
        .from(qualityIssues)
        .where(and(...conditions))
        .orderBy(asc(qualityIssues.createdAt), asc(qualityIssues.id))
        .limit(1);

      response.isSuccess = true;
      response.message = qualityIssue
        ? "Open system quality issue fetched successfully"
        : "No open system quality issue";
      response.qualityIssue = qualityIssue;
    } catch (error) {
      const message = "Unknown error in fetching open system quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetOpenSystemQualityIssue,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async createSystemQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateSystemQualityIssueDALRequest,
  ) {
    const response: Schemas.QualityIssueDALResponse = { isSuccess: false };
    // DEV_NOTE: note is free text, so it stays out of the log
    const { note: _note, ...metadata } = params;

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateSystemQualityIssue,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const conversationConditions = [
        eq(conversations.id, params.conversationId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(...conversationConditions))
        .limit(1);

      if (!conversation) {
        const message = "Conversation not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateSystemQualityIssue,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [qualityIssueResponse] = await tx
        .insert(qualityIssues)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          conversationId: params.conversationId,
          source: Schemas.QualityIssueSourceIntEnum.System,
          issueType: params.issueType,
          note: params.note,
        })
        .returning();

      response.isSuccess = true;
      response.message = "System quality issue created successfully";
      response.qualityIssue = qualityIssueResponse;
    } catch (error) {
      const message = "Unknown error in creating system quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateSystemQualityIssue,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The user issue a thumbs-down opens (M2-8): one per feedback row. A feedback row that already has its
  // issue (Down → Up → Down) keeps it as it is, whatever its status, and isCreated is false.
  async createUserQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateUserQualityIssueDALRequest,
  ) {
    const response: Schemas.UserQualityIssueDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing, in one query: the feedback row
      // exists in the company and rates a message of this conversation, which exists in the company too
      const referenceConditions = [
        eq(feedback.id, params.feedbackId),
        eq(feedback.companyId, params.companyId),
        eq(messages.companyId, params.companyId),
        eq(messages.conversationId, params.conversationId),
        eq(conversations.id, params.conversationId),
        eq(conversations.companyId, params.companyId),
      ];
      const [reference] = await tx
        .select({ feedbackId: feedback.id })
        .from(feedback)
        .innerJoin(messages, eq(messages.id, feedback.messageId))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...referenceConditions))
        .limit(1);

      if (!reference) {
        const message = "Feedback not found in the conversation";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateUserQualityIssue,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [created] = await tx
        .insert(qualityIssues)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          conversationId: params.conversationId,
          feedbackId: params.feedbackId,
          source: Schemas.QualityIssueSourceIntEnum.User,
        })
        .onConflictDoNothing({ target: qualityIssues.feedbackId })
        .returning();

      if (created) {
        response.isSuccess = true;
        response.message = "User quality issue created successfully";
        response.qualityIssue = created;
        response.isCreated = true;
        return response;
      }

      const existingConditions = [
        eq(qualityIssues.feedbackId, params.feedbackId),
        eq(qualityIssues.companyId, params.companyId),
      ];
      const [existing] = await tx
        .select()
        .from(qualityIssues)
        .where(and(...existingConditions))
        .limit(1);

      if (!existing) {
        const message = "Quality issue for the feedback not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateUserQualityIssue,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "User quality issue already exists";
      response.qualityIssue = existing;
      response.isCreated = false;
    } catch (error) {
      const message = "Unknown error in creating user quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateUserQualityIssue,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Replaces an issue's note (the key-failure path adds a provider to the open system issue). note is free
  // text, so it stays out of the log.
  async updateQualityIssueNote(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateQualityIssueNoteDALRequest,
  ) {
    const response: Schemas.QualityIssueDALResponse = { isSuccess: false };
    const { note: _note, ...metadata } = params;

    try {
      const conditions = [
        eq(qualityIssues.publicId, params.publicId),
        eq(qualityIssues.companyId, params.companyId),
      ];
      const [qualityIssueResponse] = await tx
        .update(qualityIssues)
        .set({ note: params.note, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!qualityIssueResponse) {
        const message = "Quality issue not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateQualityIssueNote,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Quality issue note updated successfully";
      response.qualityIssue = qualityIssueResponse;
    } catch (error) {
      const message = "Unknown error in updating quality issue note";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateQualityIssueNote,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Open issues by source, joined to the conversation for the chatbot. userCount = the thumbs-down ones.
  async getOpenQualityIssueCounts(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountOpenQualityIssuesDALRequest,
  ) {
    const response: Schemas.OpenQualityIssueCountsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(qualityIssues.companyId, params.companyId),
        eq(qualityIssues.status, Schemas.QualityIssueStatusIntEnum.Open),
        eq(conversations.companyId, params.companyId),
      ];
      if (params.chatbotId !== null) conditions.push(eq(conversations.chatbotId, params.chatbotId));
      const groups = await tx
        .select({ source: qualityIssues.source, count: count() })
        .from(qualityIssues)
        .innerJoin(conversations, eq(conversations.id, qualityIssues.conversationId))
        .where(and(...conditions))
        .groupBy(qualityIssues.source);

      response.isSuccess = true;
      response.message = "Open quality issues counted successfully";
      response.totalCount = groups.reduce((total, group) => total + group.count, 0);
      response.userCount =
        groups.find((group) => group.source === Schemas.QualityIssueSourceIntEnum.User)?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting open quality issues";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountOpenQualityIssues,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: An admin's flag on a conversation (M4-4). Transaction-scoped advisory lock on (company, conversation),
  // held until the Repo's transaction ends, so two flags at once take turns: the second finds the first one's open
  // issue and returns it (isCreated false) instead of opening another. A flag after that issue was dismissed or fixed
  // opens a new one.
  async createAdminQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateAdminQualityIssueDALRequest,
  ) {
    const response: Schemas.AdminQualityIssueDALResponse = { isSuccess: false };

    try {
      const lockKey = `quality_issue:admin:${params.companyId}:${params.conversationId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing
      const conversationConditions = [
        eq(conversations.id, params.conversationId),
        eq(conversations.companyId, params.companyId),
      ];
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(...conversationConditions))
        .limit(1);
      if (!conversation) {
        const message = "Conversation not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateAdminQualityIssue,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const adminConditions = [
        eq(admins.id, params.createdBy),
        eq(admins.companyId, params.companyId),
      ];
      const [admin] = await tx
        .select({ id: admins.id })
        .from(admins)
        .where(and(...adminConditions))
        .limit(1);
      if (!admin) {
        const message = "Admin not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateAdminQualityIssue,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const openConditions = [
        eq(qualityIssues.companyId, params.companyId),
        eq(qualityIssues.conversationId, params.conversationId),
        eq(qualityIssues.source, Schemas.QualityIssueSourceIntEnum.Admin),
        eq(qualityIssues.status, Schemas.QualityIssueStatusIntEnum.Open),
      ];
      const [open] = await tx
        .select()
        .from(qualityIssues)
        .where(and(...openConditions))
        .orderBy(asc(qualityIssues.createdAt), asc(qualityIssues.id))
        .limit(1);
      if (open) {
        response.isSuccess = true;
        response.message = "Admin quality issue already open";
        response.qualityIssue = open;
        response.isCreated = false;
        return response;
      }

      const [created] = await tx
        .insert(qualityIssues)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          conversationId: params.conversationId,
          source: Schemas.QualityIssueSourceIntEnum.Admin,
          createdBy: params.createdBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Admin quality issue created successfully";
      response.qualityIssue = created;
      response.isCreated = true;
    } catch (error) {
      const message = "Unknown error in creating admin quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateAdminQualityIssue,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The Quality page's issues (M4-6): with the conversation each is about (inner join: every issue has one),
  // its chatbot and user, and left joins on the change request, the test it became and the rated reply with its
  // rating (no DB foreign keys, so a row whose chatbot, user, change or test is gone still reads)
  private dashboardQuery(tx: NodePgTransaction<EmptyRelations>) {
    const conversationJoinConditions = [
      eq(conversations.id, qualityIssues.conversationId),
      eq(conversations.companyId, qualityIssues.companyId),
    ];
    const chatbotJoinConditions = [
      eq(chatbots.id, conversations.chatbotId),
      eq(chatbots.companyId, conversations.companyId),
    ];
    const userJoinConditions = [
      eq(chatbotUsers.id, conversations.chatbotUserId),
      eq(chatbotUsers.companyId, conversations.companyId),
    ];
    const changeRequestJoinConditions = [
      eq(changeRequests.id, qualityIssues.changeRequestId),
      eq(changeRequests.companyId, qualityIssues.companyId),
    ];
    const evalCaseJoinConditions = [
      eq(evalCases.id, qualityIssues.evalCaseId),
      eq(evalCases.companyId, qualityIssues.companyId),
    ];
    const feedbackJoinConditions = [
      eq(feedback.id, qualityIssues.feedbackId),
      eq(feedback.companyId, qualityIssues.companyId),
    ];
    const messageJoinConditions = [
      eq(messages.id, feedback.messageId),
      eq(messages.companyId, feedback.companyId),
    ];
    return tx
      .select({
        id: qualityIssues.id,
        publicId: qualityIssues.publicId,
        conversationId: qualityIssues.conversationId,
        conversationRootLogId: conversations.rootLogId,
        chatbotId: conversations.chatbotId,
        source: qualityIssues.source,
        status: qualityIssues.status,
        issueType: qualityIssues.issueType,
        note: qualityIssues.note,
        createdAt: qualityIssues.createdAt,
        updatedAt: qualityIssues.updatedAt,
        conversationPublicId: conversations.publicId,
        conversationTitle: conversations.title,
        conversationContentPurgedAt: conversations.contentPurgedAt,
        chatbotName: chatbots.name,
        // DEV_NOTE: An erased user keeps its row, not its name
        userName: sql<
          string | null
        >`case when ${chatbotUsers.erasedAt} is null then ${chatbotUsers.displayName} end`,
        changeRequestPublicId: changeRequests.publicId,
        evalCasePublicId: evalCases.publicId,
        evalCaseName: evalCases.name,
        ratedMessageId: messages.id,
        // DEV_NOTE: Only the start of the reply's text: the list shows QUALITY_ISSUE_EXCERPT_MAX_CHARS of it
        ratedReplyText: sql<
          string | null
        >`left(${messages.content}->>'text', ${Schemas.QUALITY_ISSUE_EXCERPT_MAX_CHARS + 1})`,
        rating: feedback.rating,
      })
      .from(qualityIssues)
      .innerJoin(conversations, and(...conversationJoinConditions))
      .leftJoin(chatbots, and(...chatbotJoinConditions))
      .leftJoin(chatbotUsers, and(...userJoinConditions))
      .leftJoin(changeRequests, and(...changeRequestJoinConditions))
      .leftJoin(evalCases, and(...evalCaseJoinConditions))
      .leftJoin(feedback, and(...feedbackJoinConditions))
      .leftJoin(messages, and(...messageJoinConditions));
  }

  // DEV_NOTE: The list's filters but the tab, shared by the list and its counts. The chatbot is the conversation's.
  private dashboardConditions(params: Schemas.CountDashboardQualityIssuesDALRequest): SQL[] {
    const conditions: SQL[] = [
      eq(qualityIssues.companyId, params.companyId),
      eq(conversations.companyId, params.companyId),
    ];
    if (params.chatbotId !== null) conditions.push(eq(conversations.chatbotId, params.chatbotId));
    return conditions;
  }

  async getDashboardQualityIssues(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetDashboardQualityIssuesDALRequest,
  ) {
    const response: Schemas.DashboardQualityIssuesDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.QualityIssueSortColumn.CreatedAt]: qualityIssues.createdAt,
        [Schemas.QualityIssueSortColumn.UpdatedAt]: qualityIssues.updatedAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const conditions = this.dashboardConditions(params);
      conditions.push(eq(qualityIssues.status, Schemas.QUALITY_ISSUE_TAB_STATUS[params.tab]));
      const selected = await this.dashboardQuery(tx)
        .where(and(...conditions))
        // DEV_NOTE: id breaks ties (same created_at), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(qualityIssues.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Quality issues fetched successfully";
      response.qualityIssues = selected;
    } catch (error) {
      const message = "Unknown error in listing quality issues";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardQualityIssues,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every tab's count in one read, under the same chatbot filter; totalRecords = all of them
  async getDashboardQualityIssuesCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountDashboardQualityIssuesDALRequest,
  ) {
    const response: Schemas.QualityIssueTabCountsDALResponse = { isSuccess: false };

    try {
      const { Open, Converted, Fixed, Dismissed } = Schemas.QualityIssueListTabEnum;
      const countOf = (tab: Schemas.QualityIssueListTabEnum) =>
        sql<number>`count(*) filter (where ${qualityIssues.status} = ${Schemas.QUALITY_ISSUE_TAB_STATUS[tab]})`.mapWith(
          Number,
        );
      const conversationJoinConditions = [
        eq(conversations.id, qualityIssues.conversationId),
        eq(conversations.companyId, qualityIssues.companyId),
      ];
      const [result] = await tx
        .select({
          all: count(),
          open: countOf(Open),
          converted: countOf(Converted),
          fixed: countOf(Fixed),
          dismissed: countOf(Dismissed),
        })
        .from(qualityIssues)
        .innerJoin(conversations, and(...conversationJoinConditions))
        .where(and(...this.dashboardConditions(params)));

      response.isSuccess = true;
      response.message = "Quality issues counted successfully";
      response.totalRecords = result?.all ?? 0;
      response.tabCounts = {
        [Open]: result?.open ?? 0,
        [Converted]: result?.converted ?? 0,
        [Fixed]: result?.fixed ?? 0,
        [Dismissed]: result?.dismissed ?? 0,
      };
    } catch (error) {
      const message = "Unknown error in counting quality issues";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountDashboardQualityIssues,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One issue by its public id within the company. isForUpdate locks the issue only: Postgres refuses to lock
  // the nullable side of an outer join.
  async getDashboardQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindDashboardQualityIssueDALRequest,
  ) {
    const response: Schemas.DashboardQualityIssueDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(qualityIssues.publicId, params.publicId),
        eq(qualityIssues.companyId, params.companyId),
      ];
      const query = this.dashboardQuery(tx)
        .where(and(...conditions))
        .limit(1);
      const [selected] = params.isForUpdate
        ? await query.for("update", { of: qualityIssues })
        : await query;

      if (!selected) {
        const message = "Quality issue not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetDashboardQualityIssue,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Quality issue fetched successfully";
      response.qualityIssue = selected;
    } catch (error) {
      const message = "Unknown error in fetching quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardQualityIssue,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Sets the type and / or note of an Open issue (an absent field keeps its value). isNotFound when no Open
  // issue has that id: the Repo reads the row under lock first, so that means it closed meanwhile. note is free text,
  // so it stays out of the log.
  async triageQualityIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.TriageQualityIssueDALRequest,
  ) {
    const response: Schemas.QualityIssueDALResponse = { isSuccess: false };
    const { note: _note, ...metadata } = params;

    try {
      const conditions = [
        eq(qualityIssues.id, params.id),
        eq(qualityIssues.companyId, params.companyId),
        eq(qualityIssues.status, Schemas.QualityIssueStatusIntEnum.Open),
      ];
      const [updated] = await tx
        .update(qualityIssues)
        .set({
          ...(params.issueType !== undefined && { issueType: params.issueType }),
          ...(params.note !== undefined && { note: params.note }),
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!updated) {
        const message = "Open quality issue not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.TriageQualityIssue,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Quality issue triaged successfully";
      response.qualityIssue = updated;
    } catch (error) {
      const message = "Unknown error in triaging quality issue";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.TriageQualityIssue,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Open → Fixed, Dismissed or Converted (with the test's id). isNotFound when no Open issue has that id.
  async updateQualityIssueStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateQualityIssueStatusDALRequest,
  ) {
    const response: Schemas.QualityIssueDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(qualityIssues.id, params.id),
        eq(qualityIssues.companyId, params.companyId),
        eq(qualityIssues.status, Schemas.QualityIssueStatusIntEnum.Open),
      ];
      const [updated] = await tx
        .update(qualityIssues)
        .set({
          status: params.status,
          evalCaseId: params.evalCaseId,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!updated) {
        const message = "Open quality issue not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateQualityIssueStatus,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Quality issue status updated successfully";
      response.qualityIssue = updated;
    } catch (error) {
      const message = "Unknown error in updating quality issue status";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateQualityIssueStatus,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
