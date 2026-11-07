import { and, countDistinct, eq, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { conversations, feedback, feedbackNotes, messages } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: The columns but the embedding, which only the clustering writes
const NOTE_COLUMNS = {
  id: feedbackNotes.id,
  publicId: feedbackNotes.publicId,
  companyId: feedbackNotes.companyId,
  chatbotId: feedbackNotes.chatbotId,
  feedbackId: feedbackNotes.feedbackId,
  conversationId: feedbackNotes.conversationId,
  chatbotUserId: feedbackNotes.chatbotUserId,
  rating: feedbackNotes.rating,
  commentVersion: feedbackNotes.commentVersion,
  summary: feedbackNotes.summary,
  themeId: feedbackNotes.themeId,
  createdAt: feedbackNotes.createdAt,
  updatedAt: feedbackNotes.updatedAt,
};

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo, and every
// query filters on companyId (defence in depth on top of RLS). Visitors' notes as the themes clustering reads and writes
// them (M7-10). The note's text, its summary and embeddings are never logged.
export default class FeedbackNotesDAL {
  // DEV_NOTE: The stored note (feedback.comment), its version and thumb, and the reply it rates with that reply's
  // conversation and chatbot. isNotFound = no such feedback row.
  async getFeedbackNoteSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetFeedbackNoteSourceDALRequest,
  ) {
    const response: Schemas.FeedbackNoteSourceDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedback.id, params.feedbackId),
        eq(feedback.companyId, params.companyId),
        eq(messages.companyId, params.companyId),
        eq(conversations.companyId, params.companyId),
      ];
      const [row] = await tx
        .select({
          feedbackPublicId: feedback.publicId,
          rating: feedback.rating,
          comment: feedback.comment,
          commentVersion: feedback.commentVersion,
          chatbotUserId: feedback.chatbotUserId,
          conversationId: conversations.id,
          chatbotId: conversations.chatbotId,
          replyText: sql<string | null>`${messages.content}->>'text'`,
          isEval: sql<boolean>`${conversations.evalRunId} is not null`,
        })
        .from(feedback)
        .innerJoin(messages, eq(messages.id, feedback.messageId))
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...conditions))
        .limit(1);

      if (!row) {
        response.isNotFound = true;
        response.message = "Feedback not found";
        return response;
      }

      response.isSuccess = true;
      response.message = "Feedback note source fetched successfully";
      response.source = row;
    } catch (error) {
      const message = "Unknown error in fetching the feedback note source";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFeedbackNoteSource,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getFeedbackNoteByFeedback(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetFeedbackNoteByFeedbackDALRequest,
  ) {
    const response: Schemas.FeedbackNoteDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedbackNotes.companyId, params.companyId),
        eq(feedbackNotes.feedbackId, params.feedbackId),
      ];
      const [note] = await tx
        .select(NOTE_COLUMNS)
        .from(feedbackNotes)
        .where(and(...conditions))
        .limit(1);

      response.isSuccess = true;
      response.message = note ? "Feedback note fetched successfully" : "No feedback note";
      response.feedbackNote = note;
    } catch (error) {
      const message = "Unknown error in fetching the feedback note";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetFeedbackNoteByFeedback,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A note's summary, pending (no embedding, no theme). An edit replaces the earlier summary of the same feedback
  // row in place (UNQ_feedback_notes_feedback_id); the Repo has already taken it out of its theme.
  async upsertFeedbackNote(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpsertFeedbackNoteDALRequest,
  ) {
    const response: Schemas.FeedbackNoteDALResponse = { isSuccess: false };
    const { summary: _summary, ...metadata } = params;

    try {
      const [note] = await tx
        .insert(feedbackNotes)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          feedbackId: params.feedbackId,
          conversationId: params.conversationId,
          chatbotUserId: params.chatbotUserId,
          rating: params.rating,
          commentVersion: params.commentVersion,
          summary: params.summary,
        })
        .onConflictDoUpdate({
          target: feedbackNotes.feedbackId,
          set: {
            rating: params.rating,
            commentVersion: params.commentVersion,
            summary: params.summary,
            embedding: null,
            themeId: null,
            updatedAt: new Date(),
          },
        })
        .returning(NOTE_COLUMNS);

      response.isSuccess = true;
      response.message = "Feedback note saved successfully";
      response.feedbackNote = note;
    } catch (error) {
      const message = "Unknown error in saving the feedback note";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpsertFeedbackNote,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The note of a feedback row whose note is gone (cleared by a thumb switch). themeId = the theme it leaves.
  async deleteFeedbackNote(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeleteFeedbackNoteDALRequest,
  ) {
    const response: Schemas.DeletedFeedbackNoteDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedbackNotes.companyId, params.companyId),
        eq(feedbackNotes.feedbackId, params.feedbackId),
      ];
      const [deleted] = await tx
        .delete(feedbackNotes)
        .where(and(...conditions))
        .returning({ themeId: feedbackNotes.themeId });

      response.isSuccess = true;
      response.message = deleted ? "Feedback note deleted successfully" : "No feedback note";
      response.themeId = deleted?.themeId ?? null;
    } catch (error) {
      const message = "Unknown error in deleting the feedback note";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteFeedbackNote,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A pending note into its theme, with the embedding that placed it
  async attachFeedbackNote(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.AttachFeedbackNoteDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };
    const { embedding: _embedding, ...metadata } = params;

    try {
      const conditions = [
        eq(feedbackNotes.id, params.id),
        eq(feedbackNotes.companyId, params.companyId),
      ];
      await tx
        .update(feedbackNotes)
        .set({ themeId: params.themeId, embedding: params.embedding, updatedAt: new Date() })
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Feedback note attached successfully";
    } catch (error) {
      const message = "Unknown error in attaching the feedback note";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.AttachFeedbackNote,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: How many different users left the notes in a theme (the Quality item's second floor)
  async countFeedbackThemeUsers(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountFeedbackThemeUsersDALRequest,
  ) {
    const response: Schemas.FeedbackThemeUserCountDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(feedbackNotes.companyId, params.companyId),
        eq(feedbackNotes.themeId, params.themeId),
      ];
      const [row] = await tx
        .select({ userCount: countDistinct(feedbackNotes.chatbotUserId) })
        .from(feedbackNotes)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Feedback theme users counted successfully";
      response.userCount = row?.userCount ?? 0;
    } catch (error) {
      const message = "Unknown error in counting feedback theme users";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountFeedbackThemeUsers,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
