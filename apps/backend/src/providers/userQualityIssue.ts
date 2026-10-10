import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The thumbs-down step (M2-8), in the caller's transaction (pattern rule 1.1: a provider may hold a
// self-contained multi-DAL step a Repo runs inside its own tx; it never opens one). It never throws; a failure comes back
// as isSuccess false and FeedbackRepo rolls the rating back with it (TenantRollbackError).
//   1. The rating's user issue: one per feedback row (Open, untriaged, no note), or the one it already has, as it is.
//   2. Only when opened now: its quality_issue.opened critical event, actor the chatbot user, under the conversation's
//      root log (turns write no log rows yet; re-point the parent at the reply's turn once they do).
export default class UserQualityIssueProvider {
  private static qualityIssuesDal = new QualityIssuesDAL();

  static async open(
    tx: NodePgTransaction<EmptyRelations>,
    request: Schemas.OpenUserQualityIssueRequest,
  ): Promise<Schemas.OpenUserQualityIssueResponse> {
    const issue = await UserQualityIssueProvider.qualityIssuesDal.createUserQualityIssue(tx, {
      companyId: request.companyId,
      conversationId: request.conversationId,
      feedbackId: request.feedbackId,
    });
    if (!issue.isSuccess || !issue.qualityIssue) {
      return { isSuccess: false, message: issue.message ?? "User quality issue not opened" };
    }
    const { qualityIssue } = issue;
    // DEV_NOTE: Only an explicit false skips the event: were isCreated ever left unset, the dedupe key still turns a
    // repeat into a no-op
    if (issue.isCreated === false) {
      return { isSuccess: true, message: "User quality issue already open for this rating" };
    }

    const event = await CriticalEventProvider.record(tx, {
      companyId: request.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
      actorId: request.chatbotUserId,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
      entityVersion: null,
      parentLogId: request.conversationRootLogId,
      rootLogId: request.conversationRootLogId,
      detail: {
        source: Schemas.QualityIssueSourceIntEnum.User,
        conversationId: request.conversationId,
        messageId: request.messageId,
        feedbackId: request.feedbackId,
      },
      eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.Opened,
        qualityIssue.publicId,
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message ?? "Quality issue event not recorded" };
    }

    return {
      isSuccess: true,
      message: "User quality issue opened",
      qualityIssueId: qualityIssue.id,
      outboxId: event.outboxId,
    };
  }
}
