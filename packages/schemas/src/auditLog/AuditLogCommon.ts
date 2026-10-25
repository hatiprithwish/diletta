import { z } from "zod";
import { ActivityLogActorTypeIntEnum } from "../activityLog/ActivityLogCommon";

// DEV_NOTE: The audit log (M4-9) is not a table: it is the company's activity_log rows written by a person, an admin
// (actor Admin) or an operator (actor Operator). Every dashboard and operator write records one through
// AuditEventProvider, in the write's own transaction (a critical event: activity_log + event_outbox, pattern rule 3.5).
// The writes that already had their own event (a flag, Mark resolved, the Quality page's triage / fix / dismiss /
// convert) show up as they are. The entity types and actions here are the ones only the audit writes.
export enum AuditEntityTypeEnum {
  Chatbot = "chatbot",
  KnowledgeSource = "knowledge_source",
  KnowledgeDocument = "knowledge_document",
  DocGapCluster = "doc_gap_cluster",
  EvalCase = "eval_case",
  RoiAssumption = "roi_assumption",
  ToolDefinition = "tool_definition",
}

// DEV_NOTE: A status change is its own action (paused, resumed, turned on / off, activated, disabled), so the log says
// what happened; an edit of other fields is Updated. One request that does both records both.
export enum AuditEntityActionEnum {
  Created = "created",
  Updated = "updated",
  Deleted = "deleted",
  Paused = "paused",
  Resumed = "resumed",
  SyncStarted = "sync_started",
  Uploaded = "uploaded",
  Answered = "answered",
  Dismissed = "dismissed",
  TurnedOn = "turned_on",
  TurnedOff = "turned_off",
  VersionCreated = "version_created",
  Activated = "activated",
  Disabled = "disabled",
}

// DEV_NOTE: The actions each entity type records, the one list both sides are checked against: a Repo's
// recordAuditOrRollback call takes only an action of its entity type, and the audit log's words map
// (AuditLogProvider) must word every pair, so a new pair fails to compile until it reads as a sentence.
export const AUDIT_ENTITY_ACTIONS = {
  [AuditEntityTypeEnum.Chatbot]: [
    AuditEntityActionEnum.Created,
    AuditEntityActionEnum.Updated,
    AuditEntityActionEnum.Paused,
    AuditEntityActionEnum.Resumed,
  ],
  [AuditEntityTypeEnum.KnowledgeSource]: [
    AuditEntityActionEnum.Created,
    AuditEntityActionEnum.Updated,
    AuditEntityActionEnum.Deleted,
    AuditEntityActionEnum.Paused,
    AuditEntityActionEnum.Resumed,
    AuditEntityActionEnum.SyncStarted,
  ],
  [AuditEntityTypeEnum.KnowledgeDocument]: [
    AuditEntityActionEnum.Uploaded,
    AuditEntityActionEnum.Deleted,
  ],
  [AuditEntityTypeEnum.DocGapCluster]: [
    AuditEntityActionEnum.Answered,
    AuditEntityActionEnum.Dismissed,
  ],
  [AuditEntityTypeEnum.EvalCase]: [
    AuditEntityActionEnum.Created,
    AuditEntityActionEnum.Updated,
    AuditEntityActionEnum.TurnedOn,
    AuditEntityActionEnum.TurnedOff,
  ],
  [AuditEntityTypeEnum.RoiAssumption]: [AuditEntityActionEnum.Updated],
  [AuditEntityTypeEnum.ToolDefinition]: [
    AuditEntityActionEnum.Created,
    AuditEntityActionEnum.Updated,
    AuditEntityActionEnum.VersionCreated,
    AuditEntityActionEnum.Activated,
    AuditEntityActionEnum.Disabled,
    AuditEntityActionEnum.Deleted,
  ],
} as const satisfies Record<AuditEntityTypeEnum, readonly AuditEntityActionEnum[]>;

export type AuditEntityActionFor<T extends AuditEntityTypeEnum> =
  (typeof AUDIT_ENTITY_ACTIONS)[T][number];

// DEV_NOTE: The person behind a write, by internal admins.id: the signed-in company admin for a dashboard Repo (actor
// Admin), the operator for an operator-only Repo (actor Operator, ToolDefinitionsRepo). Server-side only.
export const AUDIT_ACTOR_TYPES = [
  ActivityLogActorTypeIntEnum.Admin,
  ActivityLogActorTypeIntEnum.Operator,
] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditActor {
  actorType: AuditActorType;
  actorId: string;
}

// DEV_NOTE: What the log shows in its On column, stored at write time so a renamed or deleted entity still reads:
// the chatbot's, source's, case's or tool's name, the document's title, the group's label, the ROI task. Names the
// company gave, never chat text, values or secrets. Cut to AUDIT_LABEL_MAX_CHARS.
export const AUDIT_LABEL_MAX_CHARS = 200;

export const ZAuditEventDetail = z.object({
  label: z.string().max(AUDIT_LABEL_MAX_CHARS).nullable(),
});
export type AuditEventDetail = z.infer<typeof ZAuditEventDetail>;

export const auditEventType = (
  entityType: AuditEntityTypeEnum,
  action: AuditEntityActionEnum,
): string => `${entityType}.${action}`;

// DEV_NOTE: <event type>:<entity publicId>:<ULID>. Every admin write is its own event (two saves of the same name are
// two rows, and a retried request is a new write), so the key carries a fresh ULID per call: it never dedupes, it only
// gives event_outbox the unique key every critical event needs.
export const auditEventDedupeKey = (
  entityType: AuditEntityTypeEnum,
  action: AuditEntityActionEnum,
  entityPublicId: string,
  ulid: string,
): string => [auditEventType(entityType, action), entityPublicId, ulid].join(":");

export enum AuditLogSortColumn {
  CreatedAt = "createdAt",
}

// DEV_NOTE: Export's cap: the rows of one export, newest first. More rows = isTruncated.
export const AUDIT_LOG_EXPORT_MAX_ROWS = 5000;

// DEV_NOTE: A write's outbox rows, relayed by the route after the commit (EventOutboxRepo.relayInBackground). Never
// part of a route answer: the route takes it off before answering.
export type WithOutboxIds<T> = T & { outboxIds?: string[] };
