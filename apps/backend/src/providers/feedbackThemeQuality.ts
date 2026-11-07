import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: A Didn't like feedback theme's one Quality item (M7-10), in the caller's transaction (a self-contained
// multi-DAL step a Repo runs inside its own tx; it never opens one, never throws: a failure comes back as isSuccess
// false and the Repo rolls back). open: only for a theme with no item yet, whatever became of an earlier one, so a theme
// has one item ever (UNQ_quality_issues_feedback_theme_id). closeForTheme: the item follows its theme closed by an
// admin. Mirrors DocGapQualityProvider.
export default class FeedbackThemeQualityProvider {
  private static dal = new QualityIssuesDAL();

  static async open(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.OpenFeedbackThemeQualityIssueRequest,
  ): Promise<Schemas.OpenFeedbackThemeQualityIssueResponse> {
    const { companyId, chatbotId, feedbackThemeId } = params;
    const existing = await FeedbackThemeQualityProvider.dal.getQualityIssueByFeedbackTheme(tx, {
      companyId,
      feedbackThemeId,
      isForUpdate: false,
    });
    if (!existing.isSuccess) return { isSuccess: false, message: existing.message };
    if (existing.qualityIssue) {
      return { isSuccess: true, message: "The theme already opened its item", isOpened: false };
    }

    const issueType = Schemas.QualityIssueTypeIntEnum.FeedbackTheme;
    const created = await FeedbackThemeQualityProvider.dal.createSystemQualityIssue(tx, {
      companyId,
      chatbotId,
      conversationId: null,
      issueType,
      note: Schemas.feedbackThemeQualityNote(params.label),
      feedbackThemeId,
    });
    if (!created.isSuccess || !created.qualityIssue) {
      return { isSuccess: false, message: created.message, isNotFound: created.isNotFound };
    }
    const { qualityIssue } = created;

    const event = await CriticalEventProvider.record(tx, {
      companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail: {
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType,
        conversationId: null,
        feedbackThemeId,
      },
      eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.Opened,
        qualityIssue.publicId,
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message };
    }
    return {
      isSuccess: true,
      message: "Quality item opened",
      isOpened: true,
      outboxId: event.outboxId,
    };
  }

  // DEV_NOTE: The theme's item follows it closed by an admin (Resolved → Fixed, Dismissed → Dismissed); an item already
  // closed stays as it is. Closing the item on the Quality page leaves the theme alone.
  static async closeForTheme(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CloseFeedbackThemeQualityIssueRequest,
  ): Promise<Schemas.CloseFeedbackThemeQualityIssueResponse> {
    const { companyId, feedbackThemeId, status, adminId, actor } = params;
    const found = await FeedbackThemeQualityProvider.dal.getQualityIssueByFeedbackTheme(tx, {
      companyId,
      feedbackThemeId,
      isForUpdate: true,
    });
    if (!found.isSuccess) return { isSuccess: false, message: found.message };
    const { qualityIssue } = found;
    if (!qualityIssue || qualityIssue.status !== Schemas.QualityIssueStatusIntEnum.Open) {
      return { isSuccess: true, message: "No open item to close" };
    }

    const updated = await FeedbackThemeQualityProvider.dal.updateQualityIssueStatus(tx, {
      companyId,
      id: qualityIssue.id,
      status,
      evalCaseId: null,
      updatedBy: adminId,
    });
    if (!updated.isSuccess) return { isSuccess: false, message: updated.message };

    const action = Schemas.QUALITY_ISSUE_CLOSE_ENTITY_ACTION_MAP[status];
    const event = await CriticalEventProvider.record(tx, {
      companyId,
      ...actor,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: action,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail: { status, issueType: qualityIssue.issueType, feedbackThemeId },
      eventType: Schemas.qualityIssueEventType(action),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        action,
        qualityIssue.publicId,
        qualityIssue.updatedAt.toISOString(),
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message };
    }
    return { isSuccess: true, message: "Quality item closed", outboxId: event.outboxId };
  }
}
