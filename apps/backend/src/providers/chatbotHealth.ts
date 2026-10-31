import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import Constants from "@/config/Constants";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The daily health check's write (M5-5), in the caller's transaction (pattern rule 1.1: a self-contained
// multi-DAL step a Repo runs inside its own tx; it never opens one, never throws: a failure comes back as isSuccess
// false and the Repo rolls back). Mirrors ModelKeyFailureProvider, one open issue per chatbot instead of per company:
//   1. The chatbot's open System / Health drop issue (chatbot-wide: no conversation) is locked and read.
//   2. None open: a new one, its note the day's sentence, with its quality_issue.opened critical event.
//   3. One open: the day is added once (a sentence in the note and a quality_issue.health_drop_added event) unless one
//      of its events already names the day, so a rerun of the check adds nothing. Which days an issue covers is read
//      from those events' detail (ZChatbotHealthDropDetail), never from the note, which admins may edit.
export default class ChatbotHealthProvider {
  private static qualityIssuesDal = new QualityIssuesDAL();
  private static activityLogDal = new ActivityLogDAL();

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    request: Schemas.RecordChatbotHealthDropRequest,
  ): Promise<Schemas.RecordChatbotHealthDropResponse> {
    const issueType = Schemas.QualityIssueTypeIntEnum.HealthDrop;
    const find = { companyId: request.companyId, issueType, chatbotId: request.chatbotId };
    const detail: Schemas.ChatbotHealthDropDetail = { day: request.day, drops: request.drops };
    const note = Schemas.chatbotHealthNote(request.day, request.drops);

    const locked = await ChatbotHealthProvider.qualityIssuesDal.lockOpenSystemQualityIssue(
      tx,
      find,
    );
    if (!locked.isSuccess) return { isSuccess: false, message: locked.message };
    const open = await ChatbotHealthProvider.qualityIssuesDal.getOpenSystemQualityIssue(tx, find);
    if (!open.isSuccess) return { isSuccess: false, message: open.message };

    if (open.qualityIssue) {
      return await ChatbotHealthProvider.addDay(tx, {
        companyId: request.companyId,
        qualityIssue: open.qualityIssue,
        detail,
        note,
      });
    }

    const created = await ChatbotHealthProvider.qualityIssuesDal.createSystemQualityIssue(tx, {
      companyId: request.companyId,
      chatbotId: request.chatbotId,
      conversationId: null,
      issueType,
      note,
    });
    if (!created.isSuccess || !created.qualityIssue) {
      return { isSuccess: false, message: created.message };
    }
    const { qualityIssue } = created;

    const event = await CriticalEventProvider.record(tx, {
      companyId: request.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail: {
        ...detail,
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType,
        conversationId: null,
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
      message: "Health drop issue opened",
      isOpened: true,
      isAdded: false,
      outboxId: event.outboxId,
    };
  }

  // DEV_NOTE: The open issue already covers the day when one of its events names it
  private static async addDay(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      qualityIssue: Schemas.QualityIssue;
      detail: Schemas.ChatbotHealthDropDetail;
      note: string;
    },
  ): Promise<Schemas.RecordChatbotHealthDropResponse> {
    const { qualityIssue, detail } = params;
    const logs = await ChatbotHealthProvider.activityLogDal.getActivityLogsByEntity(tx, {
      companyId: params.companyId,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      limit: Constants.ACTIVITY_LOGS_BY_ENTITY_LIMIT,
    });
    if (!logs.isSuccess || !logs.activityLogs) {
      return { isSuccess: false, message: logs.message };
    }
    const isCovered = logs.activityLogs.some((log) => {
      const logged = Schemas.ZChatbotHealthDropDetail.safeParse(log.detail);
      return logged.success && logged.data.day === detail.day;
    });
    if (isCovered) {
      return {
        isSuccess: true,
        message: "The open health drop issue already covers the day",
        isOpened: false,
        isAdded: false,
      };
    }

    const currentNote = qualityIssue.note ?? "";
    const extended = await ChatbotHealthProvider.qualityIssuesDal.updateQualityIssueNote(tx, {
      companyId: params.companyId,
      publicId: qualityIssue.publicId,
      note: currentNote ? `${currentNote}\n${params.note}` : params.note,
    });
    if (!extended.isSuccess) {
      return { isSuccess: false, message: extended.message };
    }

    const event = await CriticalEventProvider.record(tx, {
      companyId: params.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.HealthDropAdded,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail,
      eventType: Schemas.qualityIssueEventType(
        Schemas.QualityIssueEntityActionEnum.HealthDropAdded,
      ),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.HealthDropAdded,
        qualityIssue.publicId,
        detail.day,
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message };
    }

    return {
      isSuccess: true,
      message: "Day added to the open health drop issue",
      isOpened: false,
      isAdded: true,
      outboxId: event.outboxId,
    };
  }
}
