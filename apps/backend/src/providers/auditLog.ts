import * as Schemas from "@app/schemas";

// DEV_NOTE: The audit log's words (M4-9), pure and unit-tested. Every action an admin or operator writes has its
// sentence here: the audit rows (Schemas.AuditEntityTypeEnum × AuditEntityActionEnum) and the admin events other pages
// already recorded (flag, Quality page, Mark resolved). A row this map doesn't know reads as a generic "Changed …"
// rather than an internal name. On = the label stored with the row (ZAuditEventDetail), with the version for a tool.
// The audit rows' words are typed by Schemas.AUDIT_ENTITY_ACTIONS, so every pair a Repo can record must be worded here.
type AuditActionWords = {
  [T in Schemas.AuditEntityTypeEnum]: Record<Schemas.AuditEntityActionFor<T>, string>;
};

const AUDIT_ACTION_WORDS: AuditActionWords = {
  [Schemas.AuditEntityTypeEnum.Chatbot]: {
    [Schemas.AuditEntityActionEnum.Created]: "Created chatbot",
    [Schemas.AuditEntityActionEnum.Updated]: "Renamed chatbot",
    [Schemas.AuditEntityActionEnum.Paused]: "Paused chatbot",
    [Schemas.AuditEntityActionEnum.Resumed]: "Resumed chatbot",
    [Schemas.AuditEntityActionEnum.MadeDefault]: "Made chatbot the default",
  },
  [Schemas.AuditEntityTypeEnum.KnowledgeSource]: {
    [Schemas.AuditEntityActionEnum.Created]: "Added knowledge source",
    [Schemas.AuditEntityActionEnum.Updated]: "Edited knowledge source",
    [Schemas.AuditEntityActionEnum.Deleted]: "Deleted knowledge source",
    [Schemas.AuditEntityActionEnum.Paused]: "Paused knowledge source",
    [Schemas.AuditEntityActionEnum.Resumed]: "Resumed knowledge source",
    [Schemas.AuditEntityActionEnum.SyncStarted]: "Synced knowledge source",
  },
  [Schemas.AuditEntityTypeEnum.KnowledgeDocument]: {
    [Schemas.AuditEntityActionEnum.Uploaded]: "Uploaded file",
    [Schemas.AuditEntityActionEnum.Deleted]: "Removed file",
  },
  [Schemas.AuditEntityTypeEnum.DocGapCluster]: {
    [Schemas.AuditEntityActionEnum.Answered]: "Answered unanswered questions",
    [Schemas.AuditEntityActionEnum.Dismissed]: "Dismissed unanswered questions",
  },
  [Schemas.AuditEntityTypeEnum.EvalCase]: {
    [Schemas.AuditEntityActionEnum.Created]: "Created test case",
    [Schemas.AuditEntityActionEnum.Updated]: "Edited test case",
    [Schemas.AuditEntityActionEnum.TurnedOn]: "Turned on test case",
    [Schemas.AuditEntityActionEnum.TurnedOff]: "Turned off test case",
  },
  [Schemas.AuditEntityTypeEnum.RoiAssumption]: {
    [Schemas.AuditEntityActionEnum.Updated]: "Changed minutes saved",
  },
  [Schemas.AuditEntityTypeEnum.ToolDefinition]: {
    [Schemas.AuditEntityActionEnum.Created]: "Added tool",
    [Schemas.AuditEntityActionEnum.Updated]: "Edited tool",
    [Schemas.AuditEntityActionEnum.VersionCreated]: "Created tool version",
    [Schemas.AuditEntityActionEnum.Activated]: "Activated tool",
    [Schemas.AuditEntityActionEnum.Disabled]: "Disabled tool",
    [Schemas.AuditEntityActionEnum.Deleted]: "Deleted tool draft",
  },
  [Schemas.AuditEntityTypeEnum.CompanyConnection]: {
    [Schemas.AuditEntityActionEnum.OriginsChanged]: "Changed allowed origins",
  },
  [Schemas.AuditEntityTypeEnum.CompanyEncryptionKey]: {
    [Schemas.AuditEntityActionEnum.Rotated]: "Rotated encryption key",
  },
  [Schemas.AuditEntityTypeEnum.Company]: {
    [Schemas.AuditEntityActionEnum.RetentionChanged]: "Changed chat retention",
    [Schemas.AuditEntityActionEnum.TurnedOn]: "Turned on read-only mode",
    [Schemas.AuditEntityActionEnum.TurnedOff]: "Turned off read-only mode",
    [Schemas.AuditEntityActionEnum.BudgetChanged]: "Changed spending budget",
  },
  [Schemas.AuditEntityTypeEnum.ModelKey]: {
    [Schemas.AuditEntityActionEnum.Created]: "Added model key",
    [Schemas.AuditEntityActionEnum.Rotated]: "Rotated model key",
  },
  [Schemas.AuditEntityTypeEnum.ChatbotConfig]: {
    [Schemas.AuditEntityActionEnum.Created]: "Started a draft version",
    [Schemas.AuditEntityActionEnum.Updated]: "Edited a draft version",
    [Schemas.AuditEntityActionEnum.Discarded]: "Discarded a draft version",
    [Schemas.AuditEntityActionEnum.Published]: "Published a version",
  },
};

// DEV_NOTE: The admin events other pages record with their own entity types
const EVENT_ACTION_WORDS: Record<string, Record<string, string>> = {
  [Schemas.QUALITY_ISSUE_ENTITY_TYPE]: {
    [Schemas.QualityIssueEntityActionEnum.Opened]: "Flagged conversation",
    [Schemas.QualityIssueEntityActionEnum.Triaged]: "Triaged quality issue",
    [Schemas.QualityIssueEntityActionEnum.Fixed]: "Marked quality issue fixed",
    [Schemas.QualityIssueEntityActionEnum.Dismissed]: "Dismissed quality issue",
    [Schemas.QualityIssueEntityActionEnum.Converted]: "Turned quality issue into a test",
  },
  [Schemas.CHANGE_REQUEST_ENTITY_TYPE]: {
    [Schemas.ChangeRequestEntityActionEnum.Resolved]: "Marked change resolved",
  },
};

const ACTION_WORDS: Record<string, Record<string, string>> = {
  ...AUDIT_ACTION_WORDS,
  ...EVENT_ACTION_WORDS,
};

const UNKNOWN_ACTION_WORDS = "Changed a setting";

export default class AuditLogProvider {
  static actionWords(entityType: string, entityAction: string): string {
    return ACTION_WORDS[entityType]?.[entityAction] ?? UNKNOWN_ACTION_WORDS;
  }

  // DEV_NOTE: The stored label, read through ZAuditEventDetail (a row without one, such as a quality issue event, has
  // none); a tool's version follows its name
  static onText(
    row: Pick<Schemas.AuditLogRow, "entityType" | "entityVersion" | "detail">,
  ): string | null {
    const parsed = Schemas.ZAuditEventDetail.safeParse(row.detail);
    const label = parsed.success ? parsed.data.label : null;
    if (label === null) return null;
    if (
      row.entityType === Schemas.AuditEntityTypeEnum.ToolDefinition &&
      row.entityVersion !== null
    ) {
      return `${label} v${row.entityVersion}`;
    }
    return label;
  }

  static toEntry(row: Schemas.AuditLogRow): Schemas.AuditLogEntry {
    return {
      actorType: row.actorType,
      actorTypeLabel: Schemas.ACTIVITY_LOG_ACTOR_TYPE_LABEL_MAP[row.actorType],
      actorName: row.actorName,
      action: AuditLogProvider.actionWords(row.entityType, row.entityAction),
      on: AuditLogProvider.onText(row),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
