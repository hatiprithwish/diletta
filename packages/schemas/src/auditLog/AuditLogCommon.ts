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
  // DEV_NOTE: The Security page's own settings (M4-9)
  CompanyConnection = "company_connection",
  CompanyEncryptionKey = "company_encryption_key",
  Company = "company",
  // DEV_NOTE: Settings › Bots (M4-10): a chatbot's versions
  ChatbotConfig = "chatbot_config",
  // DEV_NOTE: Settings › Model keys (M4-10): a model key (company_secrets of type model key)
  ModelKey = "model_key",
  // DEV_NOTE: Settings › Team (M4-10): an invite (admin_invites) and a company admin (admins, addressed by clerk_user_id)
  AdminInvite = "admin_invite",
  Admin = "admin",
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
  OriginsChanged = "origins_changed",
  Rotated = "rotated",
  RetentionChanged = "retention_changed",
  MadeDefault = "made_default",
  Discarded = "discarded",
  Published = "published",
  SentToTesting = "sent_to_testing",
  MovedToDraft = "moved_to_draft",
  PassedGate = "passed_gate",
  FailedGate = "failed_gate",
  BudgetChanged = "budget_changed",
  Revoked = "revoked",
  Removed = "removed",
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
    AuditEntityActionEnum.MadeDefault,
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
  [AuditEntityTypeEnum.CompanyConnection]: [AuditEntityActionEnum.OriginsChanged],
  [AuditEntityTypeEnum.CompanyEncryptionKey]: [AuditEntityActionEnum.Rotated],
  [AuditEntityTypeEnum.Company]: [
    AuditEntityActionEnum.RetentionChanged,
    AuditEntityActionEnum.TurnedOn,
    AuditEntityActionEnum.TurnedOff,
    AuditEntityActionEnum.BudgetChanged,
  ],
  [AuditEntityTypeEnum.ModelKey]: [AuditEntityActionEnum.Created, AuditEntityActionEnum.Rotated],
  [AuditEntityTypeEnum.AdminInvite]: [AuditEntityActionEnum.Created, AuditEntityActionEnum.Revoked],
  [AuditEntityTypeEnum.Admin]: [AuditEntityActionEnum.Removed],
  [AuditEntityTypeEnum.ChatbotConfig]: [
    AuditEntityActionEnum.Created,
    AuditEntityActionEnum.Updated,
    AuditEntityActionEnum.Discarded,
    AuditEntityActionEnum.SentToTesting,
    AuditEntityActionEnum.MovedToDraft,
    AuditEntityActionEnum.PassedGate,
    AuditEntityActionEnum.FailedGate,
    AuditEntityActionEnum.Published,
  ],
} as const satisfies Record<AuditEntityTypeEnum, readonly AuditEntityActionEnum[]>;

export type AuditEntityActionFor<T extends AuditEntityTypeEnum> =
  (typeof AUDIT_ENTITY_ACTIONS)[T][number];

// DEV_NOTE: Who made a write: the signed-in company admin for a dashboard Repo (actor Admin), the operator for an
// operator-only Repo (actor Operator, ToolDefinitionsRepo), both by internal admins.id; or the platform itself (actor
// System, no id) for a change no person made, on the entity types in AUDIT_SYSTEM_ENTITY_TYPES only (M5-4: a gate run's
// finish moving a chatbot version). Server-side only.
export const AUDIT_ACTOR_TYPES = [
  ActivityLogActorTypeIntEnum.Admin,
  ActivityLogActorTypeIntEnum.Operator,
  ActivityLogActorTypeIntEnum.System,
] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export type AuditActor =
  | {
      actorType: ActivityLogActorTypeIntEnum.Admin | ActivityLogActorTypeIntEnum.Operator;
      actorId: string;
    }
  | { actorType: ActivityLogActorTypeIntEnum.System; actorId: null };

// DEV_NOTE: The entity types whose System rows are audit rows (the audit log reads them, the partial index
// IDX_activity_log_company_id_created_at_audit covers them); every other System row is a runtime event, never shown
export const AUDIT_SYSTEM_ENTITY_TYPES = [AuditEntityTypeEnum.ChatbotConfig] as const;

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
