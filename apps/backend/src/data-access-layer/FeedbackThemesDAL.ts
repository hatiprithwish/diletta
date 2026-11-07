import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbots, conversations, feedbackNotes, feedbackThemes, qualityIssues } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: A theme's columns but the centroid, which only the clustering reads
const THEME_COLUMNS = {
  id: feedbackThemes.id,
  publicId: feedbackThemes.publicId,
  companyId: feedbackThemes.companyId,
  chatbotId: feedbackThemes.chatbotId,
  rating: feedbackThemes.rating,
  label: feedbackThemes.label,
  noteCount: feedbackThemes.noteCount,
  status: feedbackThemes.status,
  createdAt: feedbackThemes.createdAt,
  updatedAt: feedbackThemes.updatedAt,
};

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). Feedback themes (M7-10) as the clustering finds, creates,
// grows and shrinks them. Labels (summaries already rewritten without personal details) and centroids are never logged.
export default class FeedbackThemesDAL {
  // DEV_NOTE: One clustering at a time per chatbot and thumb (until the commit), so two notes arriving together can't
  // each start the same theme or both cross the Quality floor
  async lockFeedbackTheming(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.LockFeedbackThemingDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKey = `feedback_theming:${params.companyId}:${params.chatbotId}:${params.rating}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      response.isSuccess = true;
      response.message = "Feedback theming locked successfully";
    } catch (error) {
      const message = "Unknown error in locking feedback theming";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockFeedbackTheming,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The chatbot's closest theme of the same thumb a note may join: Open or Dismissed, never Resolved. Locked, so
  // an admin closing it waits for this write and the Quality check reads its real status. A chatbot holds few themes, so
  // this sorts them rather than keep an index on centroids. isSuccess with no theme = none yet.
  async findNearestFeedbackTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindNearestFeedbackThemeDALRequest,
  ) {
    const response: Schemas.NearestFeedbackThemeDALResponse = { isSuccess: false };
    const { embedding: _embedding, ...metadata } = params;

    try {
      const distance = sql<number>`${feedbackThemes.centroid} <=> ${JSON.stringify(params.embedding)}::halfvec`;
      const conditions = [
        eq(feedbackThemes.companyId, params.companyId),
        eq(feedbackThemes.chatbotId, params.chatbotId),
        eq(feedbackThemes.rating, params.rating),
        inArray(feedbackThemes.status, [
          Schemas.FeedbackThemeStatusIntEnum.Open,
          Schemas.FeedbackThemeStatusIntEnum.Dismissed,
        ]),
      ];
      const [nearest] = await tx
        .select({
          ...THEME_COLUMNS,
          centroid: feedbackThemes.centroid,
          similarity: sql<number>`1 - (${distance})`.mapWith(Number),
        })
        .from(feedbackThemes)
        .where(and(...conditions))
        .orderBy(asc(distance), asc(feedbackThemes.id))
        .limit(1)
        .for("update");

      response.isSuccess = true;
      response.message = nearest ? "Nearest feedback theme found" : "No feedback theme to join";
      response.feedbackTheme = nearest;
    } catch (error) {
      const message = "Unknown error in finding nearest feedback theme";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.FindNearestFeedbackTheme,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A new Open theme from its first note (its label and centroid). The Repo holds the clustering lock; a removed
  // chatbot is checked here (no DB foreign keys), isNotFound.
  async createFeedbackTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateFeedbackThemeDALRequest,
  ) {
    const response: Schemas.FeedbackThemeDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      chatbotId: params.chatbotId,
      rating: params.rating,
    };

    try {
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
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateFeedbackTheme,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      const [created] = await tx
        .insert(feedbackThemes)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          rating: params.rating,
          label: params.label,
          centroid: params.centroid,
          noteCount: 1,
        })
        .returning(THEME_COLUMNS);

      response.isSuccess = true;
      response.message = "Feedback theme created successfully";
      response.feedbackTheme = created;
    } catch (error) {
      const message = "Unknown error in creating feedback theme";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateFeedbackTheme,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  async growFeedbackTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GrowFeedbackThemeDALRequest,
  ) {
    const response: Schemas.FeedbackThemeDALResponse = { isSuccess: false };
    const { centroid: _centroid, ...metadata } = params;

    try {
      const conditions = [
        eq(feedbackThemes.id, params.id),
        eq(feedbackThemes.companyId, params.companyId),
      ];
      const [updated] = await tx
        .update(feedbackThemes)
        .set({ centroid: params.centroid, noteCount: params.noteCount, updatedAt: new Date() })
        .where(and(...conditions))
        .returning(THEME_COLUMNS);

      if (!updated) {
        const message = "Feedback theme not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GrowFeedbackTheme,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Feedback theme grown successfully";
      response.feedbackTheme = updated;
    } catch (error) {
      const message = "Unknown error in growing feedback theme";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GrowFeedbackTheme,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One note left the theme (edited, or cleared by a thumb switch). The count never goes below 0; a theme
  // left empty stays (its Quality item, if any, keeps pointing at it).
  async shrinkFeedbackTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ShrinkFeedbackThemeDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedbackThemes.id, params.id),
        eq(feedbackThemes.companyId, params.companyId),
      ];
      await tx
        .update(feedbackThemes)
        .set({
          noteCount: sql`greatest(${feedbackThemes.noteCount} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Feedback theme shrunk successfully";
    } catch (error) {
      const message = "Unknown error in shrinking feedback theme";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ShrinkFeedbackTheme,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A theme with its chatbot's name, its Quality item (left joins: no DB foreign keys), how many different users
  // left its notes, and its newest note's summary and time (correlated reads on IDX_feedback_notes_theme_id)
  private rowQuery(tx: NodePgTransaction<EmptyRelations>) {
    const chatbotJoinConditions = [
      eq(chatbots.id, feedbackThemes.chatbotId),
      eq(chatbots.companyId, feedbackThemes.companyId),
    ];
    const qualityIssueJoinConditions = [
      eq(qualityIssues.feedbackThemeId, feedbackThemes.id),
      eq(qualityIssues.companyId, feedbackThemes.companyId),
    ];
    const inTheme = sql`${feedbackNotes.themeId} = ${feedbackThemes.id} and ${feedbackNotes.companyId} = ${feedbackThemes.companyId}`;
    return tx
      .select({
        ...THEME_COLUMNS,
        chatbotName: chatbots.name,
        qualityIssuePublicId: qualityIssues.publicId,
        userCount: sql<number>`(
          select count(distinct ${feedbackNotes.chatbotUserId}) from ${feedbackNotes} where ${inTheme}
        )`.mapWith(Number),
        latestSummary: sql<string | null>`(
          select ${feedbackNotes.summary} from ${feedbackNotes} where ${inTheme}
          order by ${feedbackNotes.updatedAt} desc, ${feedbackNotes.id} desc limit 1
        )`,
        latestNoteAt: sql<Date | null>`(
          select max(${feedbackNotes.updatedAt}) from ${feedbackNotes} where ${inTheme}
        )`.mapWith(feedbackNotes.updatedAt),
      })
      .from(feedbackThemes)
      .leftJoin(chatbots, and(...chatbotJoinConditions))
      .leftJoin(qualityIssues, and(...qualityIssueJoinConditions));
  }

  async getFeedbackThemes(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetFeedbackThemesDALRequest,
  ) {
    const response: Schemas.FeedbackThemeRowsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.FeedbackThemeSortColumn.NoteCount]: feedbackThemes.noteCount,
        [Schemas.FeedbackThemeSortColumn.CreatedAt]: feedbackThemes.createdAt,
        [Schemas.FeedbackThemeSortColumn.UpdatedAt]: feedbackThemes.updatedAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const conditions = [
        eq(feedbackThemes.companyId, params.companyId),
        eq(feedbackThemes.rating, params.rating),
        eq(feedbackThemes.status, params.status),
      ];
      const rows = await this.rowQuery(tx)
        .where(and(...conditions))
        // DEV_NOTE: id breaks ties (same note count), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(feedbackThemes.id))
        .limit(params.pageSize)
        .offset((params.pageNo - 1) * params.pageSize);

      response.isSuccess = true;
      response.message = "Feedback themes fetched successfully";
      response.feedbackThemes = rows;
    } catch (error) {
      const message = "Unknown error in listing feedback themes";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFeedbackThemes,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every status × thumb count in one read
  async countFeedbackThemes(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountFeedbackThemesDALRequest,
  ) {
    const response: Schemas.FeedbackThemeCountsDALResponse = { isSuccess: false };

    try {
      const rows = await tx
        .select({
          status: feedbackThemes.status,
          rating: feedbackThemes.rating,
          count: count(),
        })
        .from(feedbackThemes)
        .where(eq(feedbackThemes.companyId, params.companyId))
        .groupBy(feedbackThemes.status, feedbackThemes.rating);

      const empty = () => ({
        [Schemas.FeedbackRatingIntEnum.Up]: 0,
        [Schemas.FeedbackRatingIntEnum.Down]: 0,
      });
      const counts = {
        [Schemas.FeedbackThemeStatusIntEnum.Open]: empty(),
        [Schemas.FeedbackThemeStatusIntEnum.Resolved]: empty(),
        [Schemas.FeedbackThemeStatusIntEnum.Dismissed]: empty(),
      };
      for (const row of rows) counts[row.status][row.rating] = row.count;

      response.isSuccess = true;
      response.message = "Feedback themes counted successfully";
      response.counts = counts;
    } catch (error) {
      const message = "Unknown error in counting feedback themes";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountFeedbackThemes,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One theme by its public id within the company. isForUpdate locks the theme row only (Postgres refuses to
  // lock the nullable side of the left joins), read again without the joins first.
  async getFeedbackTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetFeedbackThemeDALRequest,
  ) {
    const response: Schemas.FeedbackThemeRowDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedbackThemes.companyId, params.companyId),
        eq(feedbackThemes.publicId, params.publicId),
      ];
      if (params.isForUpdate) {
        await tx
          .select({ id: feedbackThemes.id })
          .from(feedbackThemes)
          .where(and(...conditions))
          .limit(1)
          .for("update");
      }
      const [row] = await this.rowQuery(tx)
        .where(and(...conditions))
        .limit(1);

      if (!row) {
        response.isNotFound = true;
        response.message = "Feedback theme not found";
        return response;
      }

      response.isSuccess = true;
      response.message = "Feedback theme fetched successfully";
      response.feedbackTheme = row;
    } catch (error) {
      const message = "Unknown error in fetching feedback theme";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFeedbackTheme,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A theme's newest notes (their summaries), each with its conversation's public id (null once it is gone)
  async getFeedbackThemeNotes(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetFeedbackThemeNotesDALRequest,
  ) {
    const response: Schemas.FeedbackThemeNotesDALResponse = { isSuccess: false };

    try {
      const conversationJoinConditions = [
        eq(conversations.id, feedbackNotes.conversationId),
        eq(conversations.companyId, feedbackNotes.companyId),
      ];
      const conditions = [
        eq(feedbackNotes.companyId, params.companyId),
        eq(feedbackNotes.themeId, params.themeId),
      ];
      const notes = await tx
        .select({
          publicId: feedbackNotes.publicId,
          summary: feedbackNotes.summary,
          conversationPublicId: conversations.publicId,
          createdAt: feedbackNotes.updatedAt,
        })
        .from(feedbackNotes)
        .leftJoin(conversations, and(...conversationJoinConditions))
        .where(and(...conditions))
        .orderBy(desc(feedbackNotes.updatedAt), desc(feedbackNotes.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Feedback theme notes fetched successfully";
      response.notes = notes;
    } catch (error) {
      const message = "Unknown error in fetching feedback theme notes";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFeedbackThemeNotes,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Open → Resolved or Dismissed. isNotFound when no Open theme has that id.
  async closeFeedbackTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CloseFeedbackThemeDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedbackThemes.id, params.id),
        eq(feedbackThemes.companyId, params.companyId),
        eq(feedbackThemes.status, Schemas.FeedbackThemeStatusIntEnum.Open),
      ];
      const [closed] = await tx
        .update(feedbackThemes)
        .set({ status: params.status, updatedAt: new Date() })
        .where(and(...conditions))
        .returning({ id: feedbackThemes.id });

      if (!closed) {
        response.isNotFound = true;
        response.message = "Open feedback theme not found";
        return response;
      }

      response.isSuccess = true;
      response.message = "Feedback theme closed successfully";
    } catch (error) {
      const message = "Unknown error in closing feedback theme";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CloseFeedbackTheme,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
