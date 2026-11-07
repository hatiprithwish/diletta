import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbots, feedbackThemes } from "@/db/tables";
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
}
