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

describe("ChangeRequestsProvider.verifyEnd and undoEnd (M3-6)", () => {
  const check = (verdict: Schemas.ChangeRequestCheckVerdictEnum) => ({ verdict, mismatches: [] });
  const { Matches, Differs, Unknown } = Schemas.ChangeRequestCheckVerdictEnum;

  it("verifies a read-after that matches, undoes one that differs, and hands an unknown to a person", () => {
    expect(ChangeRequestsProvider.verifyEnd(check(Matches))).toEqual({
      status: Schemas.ChangeRequestStatusIntEnum.Verified,
      errorCode: null,
    });
    expect(ChangeRequestsProvider.verifyEnd(check(Differs))).toEqual({
      status: Schemas.ChangeRequestStatusIntEnum.Mismatch,
      errorCode: null,
    });
    expect(ChangeRequestsProvider.verifyEnd(check(Unknown))).toEqual({
      status: NeedsHuman,
      errorCode: Schemas.ChangeRequestErrorCodeEnum.VerifyUnknown,
    });
  });

  it("ends an undo Undone only when it succeeded and the record reads back as before", () => {
    const sent = { outcome: Outcome.Succeeded, attempts: 1 };
    expect(ChangeRequestsProvider.undoEnd(sent, check(Matches)).status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Undone,
    );
    expect(
      ChangeRequestsProvider.undoEnd(
        { outcome: Outcome.AlreadyApplied, attempts: 0 },
        check(Matches),
      ).status,
    ).toBe(Schemas.ChangeRequestStatusIntEnum.Undone);
    for (const after of [check(Differs), check(Unknown), null]) {
      expect(ChangeRequestsProvider.undoEnd(sent, after)).toEqual({
        status: NeedsHuman,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoUnconfirmed,
      });
    }
    for (const outcome of [
      Outcome.Unknown,
      Outcome.Refused,
      Outcome.Failed,
      Outcome.TokenRejected,
    ]) {
      expect(ChangeRequestsProvider.undoEnd({ outcome, attempts: 1 }, check(Matches))).toEqual({
        status: NeedsHuman,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
      });
    }
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

  it("offers editable fields only while Proposed with a readable payload, and leaves the tool call id to the DO", () => {
    const payload: Schemas.ChangeRequestPayload = {
      version: 2,
      kind: Schemas.ChangeRequestKindEnum.Update,
      args: { recordId: "rec_alpha", amount: 1 },
      before: null,
      changes: [],
      result: null,
      mismatches: null,
    };
    const editable: Schemas.ChangeRequestEditableField[] = [
      {
        field: "amount",
        type: Schemas.ChangeRequestFieldTypeEnum.Number,
        enumValues: null,
        format: null,
        isRequired: false,
      },
    ];
    expect(ChangeRequestsProvider.toView(row(), payload, editable).editableFields).toEqual(
      editable,
    );
    expect(ChangeRequestsProvider.toView(row(), null, editable).editableFields).toEqual([]);
    const approved = row({ status: Schemas.ChangeRequestStatusIntEnum.Approved });
    expect(ChangeRequestsProvider.toView(approved, payload, editable).editableFields).toEqual([]);
    expect(ChangeRequestsProvider.toView(row(), payload).toolCallId).toBeNull();
  });
});
