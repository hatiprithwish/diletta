import { and, asc, eq, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, conversations, feedback, messages, qualityIssues } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). System issues come from the model router's
// key-failure path (M2-3), user issues from a thumbs-down (M2-8); admin issues add their own methods.
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
}
