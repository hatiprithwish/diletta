import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: A group of unanswered questions' one Quality item (M5-6), in the caller's transaction (pattern rule 1.1: a
// self-contained multi-DAL step a Repo runs inside its own tx; it never opens one, never throws: a failure comes back as
// isSuccess false and the Repo rolls back). open: only for a group with no item yet, whatever became of an earlier one,
// so a group opens one item ever (UNQ_quality_issues_doc_gap_cluster_id). closeForCluster: the item follows its group
// closed by an admin; an item already closed stays as it is. Closing the item leaves the group alone.
export default class DocGapQualityProvider {
  private static dal = new QualityIssuesDAL();

  static async open(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.OpenDocGapQualityIssueRequest,
  ): Promise<Schemas.OpenDocGapQualityIssueResponse> {
    const { companyId, chatbotId, docGapClusterId } = params;
    const existing = await DocGapQualityProvider.dal.getQualityIssueByDocGapCluster(tx, {
      companyId,
      docGapClusterId,
      isForUpdate: false,
    });
    if (!existing.isSuccess) return { isSuccess: false, message: existing.message };
    if (existing.qualityIssue) {
      return { isSuccess: true, message: "The group already opened its item", isOpened: false };
    }

    const issueType = Schemas.QualityIssueTypeIntEnum.KnowledgeGap;
    const created = await DocGapQualityProvider.dal.createSystemQualityIssue(tx, {
      companyId,
      chatbotId,
      conversationId: null,
      issueType,
      note: Schemas.docGapQualityNote(params.label),
      docGapClusterId,
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
        docGapClusterId,
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

  static async closeForCluster(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CloseDocGapQualityIssueRequest,
  ): Promise<Schemas.CloseDocGapQualityIssueResponse> {
    const { companyId, docGapClusterId, status, adminId } = params;
    const found = await DocGapQualityProvider.dal.getQualityIssueByDocGapCluster(tx, {
      companyId,
      docGapClusterId,
      isForUpdate: true,
    });
    if (!found.isSuccess) return { isSuccess: false, message: found.message };
    const { qualityIssue } = found;
    if (!qualityIssue || qualityIssue.status !== Schemas.QualityIssueStatusIntEnum.Open) {
      return { isSuccess: true, message: "No open item to close" };
    }

    const updated = await DocGapQualityProvider.dal.updateQualityIssueStatus(tx, {
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
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
      actorId: adminId,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: action,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail: { status, issueType: qualityIssue.issueType, docGapClusterId },
      eventType: Schemas.qualityIssueEventType(action),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(action, qualityIssue.publicId),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message };
    }
    return { isSuccess: true, message: "Quality item closed", outboxId: event.outboxId };
  }
}
