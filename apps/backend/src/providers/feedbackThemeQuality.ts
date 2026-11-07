import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: A Didn't like feedback theme's one Quality item (M7-10), in the caller's transaction (a self-contained
// multi-DAL step a Repo runs inside its own tx; it never opens one, never throws: a failure comes back as isSuccess
// false and the Repo rolls back). open: only for a theme with no item yet, whatever became of an earlier one, so a theme
// has one item ever (UNQ_quality_issues_feedback_theme_id). Mirrors DocGapQualityProvider.
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
}
