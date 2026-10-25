import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import AuditLogProvider from "@/providers/auditLog";

// DEV_NOTE: The audit log's words (M4-9), pure: every action an admin or operator records reads as a sentence, never
// as an internal name
describe("AuditLogProvider", () => {
  it("words every audit action of every audit entity", () => {
    const unknown = AuditLogProvider.actionWords("nothing", "nothing");
    const pairs: [Schemas.AuditEntityTypeEnum, Schemas.AuditEntityActionEnum][] = [
      [Schemas.AuditEntityTypeEnum.Chatbot, Schemas.AuditEntityActionEnum.Created],
      [Schemas.AuditEntityTypeEnum.Chatbot, Schemas.AuditEntityActionEnum.Updated],
      [Schemas.AuditEntityTypeEnum.Chatbot, Schemas.AuditEntityActionEnum.Paused],
      [Schemas.AuditEntityTypeEnum.Chatbot, Schemas.AuditEntityActionEnum.Resumed],
      [Schemas.AuditEntityTypeEnum.KnowledgeSource, Schemas.AuditEntityActionEnum.Created],
      [Schemas.AuditEntityTypeEnum.KnowledgeSource, Schemas.AuditEntityActionEnum.Updated],
      [Schemas.AuditEntityTypeEnum.KnowledgeSource, Schemas.AuditEntityActionEnum.Deleted],
      [Schemas.AuditEntityTypeEnum.KnowledgeSource, Schemas.AuditEntityActionEnum.Paused],
      [Schemas.AuditEntityTypeEnum.KnowledgeSource, Schemas.AuditEntityActionEnum.Resumed],
      [Schemas.AuditEntityTypeEnum.KnowledgeSource, Schemas.AuditEntityActionEnum.SyncStarted],
      [Schemas.AuditEntityTypeEnum.KnowledgeDocument, Schemas.AuditEntityActionEnum.Uploaded],
      [Schemas.AuditEntityTypeEnum.KnowledgeDocument, Schemas.AuditEntityActionEnum.Deleted],
      [Schemas.AuditEntityTypeEnum.DocGapCluster, Schemas.AuditEntityActionEnum.Answered],
      [Schemas.AuditEntityTypeEnum.DocGapCluster, Schemas.AuditEntityActionEnum.Dismissed],
      [Schemas.AuditEntityTypeEnum.EvalCase, Schemas.AuditEntityActionEnum.Created],
      [Schemas.AuditEntityTypeEnum.EvalCase, Schemas.AuditEntityActionEnum.Updated],
      [Schemas.AuditEntityTypeEnum.EvalCase, Schemas.AuditEntityActionEnum.TurnedOn],
      [Schemas.AuditEntityTypeEnum.EvalCase, Schemas.AuditEntityActionEnum.TurnedOff],
      [Schemas.AuditEntityTypeEnum.RoiAssumption, Schemas.AuditEntityActionEnum.Updated],
      [Schemas.AuditEntityTypeEnum.ToolDefinition, Schemas.AuditEntityActionEnum.Created],
      [Schemas.AuditEntityTypeEnum.ToolDefinition, Schemas.AuditEntityActionEnum.Updated],
      [Schemas.AuditEntityTypeEnum.ToolDefinition, Schemas.AuditEntityActionEnum.VersionCreated],
      [Schemas.AuditEntityTypeEnum.ToolDefinition, Schemas.AuditEntityActionEnum.Activated],
      [Schemas.AuditEntityTypeEnum.ToolDefinition, Schemas.AuditEntityActionEnum.Disabled],
      [Schemas.AuditEntityTypeEnum.ToolDefinition, Schemas.AuditEntityActionEnum.Deleted],
    ];
    for (const [entityType, action] of pairs) {
      expect(AuditLogProvider.actionWords(entityType, action)).not.toBe(unknown);
    }
  });

  it("words the admin events other pages record", () => {
    expect(
      AuditLogProvider.actionWords(
        Schemas.QUALITY_ISSUE_ENTITY_TYPE,
        Schemas.QualityIssueEntityActionEnum.Opened,
      ),
    ).toBe("Flagged conversation");
    expect(
      AuditLogProvider.actionWords(
        Schemas.CHANGE_REQUEST_ENTITY_TYPE,
        Schemas.ChangeRequestEntityActionEnum.Resolved,
      ),
    ).toBe("Marked change resolved");
  });

  it("reads an unknown action as a generic sentence, never its internal name", () => {
    expect(AuditLogProvider.actionWords("chatbot_config", "needs_human")).toBe("Changed a setting");
  });

  it("shows the stored label, with a tool's version, and none for a row without one", () => {
    expect(
      AuditLogProvider.onText({
        entityType: Schemas.AuditEntityTypeEnum.ToolDefinition,
        entityVersion: 3,
        detail: { label: "create_record" },
      }),
    ).toBe("create_record v3");
    expect(
      AuditLogProvider.onText({
        entityType: Schemas.AuditEntityTypeEnum.EvalCase,
        entityVersion: null,
        detail: { label: "Refund question" },
      }),
    ).toBe("Refund question");
    expect(
      AuditLogProvider.onText({
        entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
        entityVersion: null,
        detail: { conversationId: "1" },
      }),
    ).toBeNull();
  });

  it("turns a row into an entry with the actor's label", () => {
    const createdAt = new Date("2026-10-25T10:20:00Z");
    expect(
      AuditLogProvider.toEntry({
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        actorName: "Ana Ruiz",
        entityType: Schemas.AuditEntityTypeEnum.KnowledgeSource,
        entityAction: Schemas.AuditEntityActionEnum.SyncStarted,
        entityVersion: null,
        detail: { label: "Help center" },
        createdAt,
      }),
    ).toEqual({
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
      actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Admin,
      actorName: "Ana Ruiz",
      action: "Synced knowledge source",
      on: "Help center",
      createdAt,
    });
  });
});
