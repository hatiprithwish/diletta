import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: A prompt injection the Conversation DO found (M6-4), recorded in the caller's transaction (a self-contained
// multi-DAL step a Repo runs inside its own tx; it never opens one, never throws: a failure comes back as isSuccess
// false and the Repo rolls back). One issue per conversation, keyed by what an admin can't change:
//   1. The conversation's prompt_injection.detected critical event (actor System; ids, where and which rule, never the
//      text). Its dedupe key is the conversation's, so only its first detection writes one: a repeat (a later turn, a
//      concurrent one waiting on the key's lock) comes back wasDuplicate and nothing more is written.
//   2. With the first: a System issue typed Prompt injection on the conversation (its chatbot's), its note where it was
//      found and what it tried (Schemas.promptInjectionNote), with its quality_issue.opened critical event. The Security
//      page lists it with the issues admins typed.
export default class PromptInjectionProvider {
  private static qualityIssuesDal = new QualityIssuesDAL();

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    request: Schemas.RecordPromptInjectionRequest,
  ): Promise<Schemas.RecordPromptInjectionResponse> {
    const issueType = Schemas.QualityIssueTypeIntEnum.Injection;
    const detail: Schemas.PromptInjectionDetail = {
      location: request.location,
      ruleId: request.ruleId,
      rulesVersion: Schemas.PROMPT_INJECTION_RULES_VERSION,
    };

    const detected = await CriticalEventProvider.record(tx, {
      companyId: request.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.PROMPT_INJECTION_ENTITY_TYPE,
      entityId: request.conversationId,
      entityAction: Schemas.PROMPT_INJECTION_ENTITY_ACTION,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail,
      eventType: Schemas.PROMPT_INJECTION_EVENT_TYPE,
      dedupeKey: Schemas.promptInjectionDedupeKey(request.conversationPublicId),
    });
    if (!detected.isSuccess || !detected.outboxId) {
      return { isSuccess: false, message: detected.message };
    }
    if (detected.wasDuplicate) {
      return {
        isSuccess: true,
        message: "The conversation's prompt injection is already recorded",
        isOpened: false,
        outboxIds: [],
      };
    }

    const created = await PromptInjectionProvider.qualityIssuesDal.createSystemQualityIssue(tx, {
      companyId: request.companyId,
      conversationId: request.conversationId,
      issueType,
      note: Schemas.promptInjectionNote(request.location, request.ruleId),
    });
    if (!created.isSuccess || !created.qualityIssue) {
      return { isSuccess: false, message: created.message };
    }
    const { qualityIssue } = created;

    const opened = await CriticalEventProvider.record(tx, {
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
        conversationId: request.conversationId,
      },
      eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.Opened,
        qualityIssue.publicId,
      ),
    });
    if (!opened.isSuccess || !opened.outboxId) {
      return { isSuccess: false, message: opened.message };
    }

    return {
      isSuccess: true,
      message: "Prompt injection issue opened",
      isOpened: true,
      outboxIds: [detected.outboxId, opened.outboxId],
    };
  }
}
