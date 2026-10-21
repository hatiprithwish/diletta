import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ChangeRequestsProvider from "@/providers/changeRequests";

// DEV_NOTE: Unit tests for the change request rules (M3-4): no DO, no database, no host

const { Committed, NeedsHuman, Failed } = Schemas.ChangeRequestStatusIntEnum;
const Outcome = Schemas.HostCallOutcomeEnum;

const row = (overrides: Partial<Schemas.ChangeRequestRow> = {}): Schemas.ChangeRequestRow => ({
  id: "1",
  publicId: "cr_1",
  companyId: "1",
  conversationId: "1",
  toolCallId: "1",
  status: Schemas.ChangeRequestStatusIntEnum.Proposed,
  encryptedChanges: null,
  iv: null,
  encryptionKeyVersion: null,
  summary: "update_record: 1 field changed",
  changeCount: 1,
  wasEdited: false,
  thinkExecutionId: null,
  idempotencyKey: null,
  hostRef: null,
  undoUntil: null,
  errorCode: null,
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
  toolId: "1",
  toolVersion: 1,
  turnId: "t",
  toolName: "update_record",
  toolRisk: Schemas.ToolDefinitionRiskIntEnum.Write,
  isUndoable: true,
  ...overrides,
});

describe("ChangeRequestsProvider.commitEnd", () => {
  it.each([
    [Outcome.Succeeded, false, 1, false, Committed],
    [Outcome.AlreadyApplied, true, 1, true, Committed],
    [Outcome.Unknown, true, 1, false, NeedsHuman],
    [Outcome.Refused, false, 1, false, Failed],
    [Outcome.TokenRejected, true, 1, false, NeedsHuman],
    [Outcome.Failed, false, 0, false, Failed],
    // DEV_NOTE: A resume that sent nothing proves nothing about the earlier attempt
    [Outcome.Failed, false, 0, true, NeedsHuman],
  ])(
    "%s (may have landed %s, attempts %i, resume %s) ends as %i",
    (outcome, mayHaveLanded, attempts, isResume, status) => {
      expect(
        ChangeRequestsProvider.commitEnd({ outcome, mayHaveLanded, attempts }, isResume).status,
      ).toBe(status);
    },
  );

  it("stores the change request's own error codes", () => {
    expect(
      ChangeRequestsProvider.commitEnd({ outcome: Outcome.Refused, attempts: 1 }, false).errorCode,
    ).toBe(Schemas.ChangeRequestErrorCodeEnum.HostRefused);
    expect(
      ChangeRequestsProvider.refusalErrorCode(Schemas.ChangeRequestFailureEnum.ToolUnavailable),
    ).toBe(Schemas.ChangeRequestErrorCodeEnum.ToolUnavailable);
  });
});

describe("ChangeRequestsProvider deadline and view", () => {
  it("puts the deadline at created_at + the approval expiry", () => {
    const deadline = 1_000 + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS;
    expect(ChangeRequestsProvider.deadline(row())).toBe(deadline);
    expect(ChangeRequestsProvider.isPastDeadline(row(), deadline - 1)).toBe(false);
    expect(ChangeRequestsProvider.isPastDeadline(row(), deadline)).toBe(true);
    expect(ChangeRequestsProvider.toView(row(), null).expiresAt).toBe(deadline);
  });

  it("shows no kind without a payload, except for a destructive tool", () => {
    expect(ChangeRequestsProvider.toView(row(), null).kind).toBeNull();
    const destructive = row({ toolRisk: Schemas.ToolDefinitionRiskIntEnum.Destructive });
    expect(ChangeRequestsProvider.toView(destructive, null).kind).toBe(
      Schemas.ChangeRequestKindEnum.Delete,
    );
  });
});
