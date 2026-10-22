import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ChangeRequestsProvider from "@/providers/changeRequests";

// DEV_NOTE: Unit tests for the change request rules (M3-4): no DO, no database, no host

const { Committed, NeedsHuman, Failed } = Schemas.ChangeRequestStatusIntEnum;
const Outcome = Schemas.HostCallOutcomeEnum;
const NOW = 10_000;

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
    expect(ChangeRequestsProvider.toView(row(), null, NOW).expiresAt).toBe(deadline);
  });

  it("shows no kind without a payload, except for a destructive tool", () => {
    expect(ChangeRequestsProvider.toView(row(), null, NOW).kind).toBeNull();
    const destructive = row({ toolRisk: Schemas.ToolDefinitionRiskIntEnum.Destructive });
    expect(ChangeRequestsProvider.toView(destructive, null, NOW).kind).toBe(
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
    expect(ChangeRequestsProvider.toView(row(), payload, NOW, editable).editableFields).toEqual(
      editable,
    );
    expect(ChangeRequestsProvider.toView(row(), null, NOW, editable).editableFields).toEqual([]);
    const approved = row({ status: Schemas.ChangeRequestStatusIntEnum.Approved });
    expect(ChangeRequestsProvider.toView(approved, payload, NOW, editable).editableFields).toEqual(
      [],
    );
    expect(ChangeRequestsProvider.toView(row(), payload, NOW).toolCallId).toBeNull();
  });
});

// DEV_NOTE: M3-7: the undo window, the user's undo and the view's undoUntil
describe("ChangeRequestsProvider undo window (M3-7)", () => {
  const { Verified, Undone, Rejected, Expired, Approved, Committing, Mismatch } =
    Schemas.ChangeRequestStatusIntEnum;
  const now = 5_000_000;
  const undoKey = Schemas.changeRequestUserUndoIdempotencyKey("cr_1");
  const verified = (overrides: Partial<Schemas.ChangeRequestRow> = {}) =>
    row({
      status: Verified,
      encryptedChanges: new Uint8Array([1]),
      undoUntil: new Date(now + 1_000),
      ...overrides,
    });

  it("sets the window on every end but NeedsHuman, clears it there, and leaves it on the way", () => {
    for (const status of [Verified, Undone, Failed, Rejected, Expired]) {
      expect(ChangeRequestsProvider.undoUntil(status, now)).toEqual(
        new Date(now + Schemas.CHANGE_REQUEST_UNDO_WINDOW_MS),
      );
    }
    expect(ChangeRequestsProvider.undoUntil(NeedsHuman, now)).toBeNull();
    for (const status of [Approved, Committing, Committed, Mismatch]) {
      expect(ChangeRequestsProvider.undoUntil(status, now)).toBeUndefined();
    }
  });

  it("lets the user undo only a Verified, undoable, unpurged one before its window ends", () => {
    expect(ChangeRequestsProvider.undoRefusal(verified(), now)).toBeNull();
    expect(ChangeRequestsProvider.undoRefusal(verified({ status: Undone }), now)).toBe(
      Schemas.ChangeRequestFailureEnum.InvalidTransition,
    );
    expect(ChangeRequestsProvider.undoRefusal(verified({ idempotencyKey: undoKey }), now)).toBe(
      Schemas.ChangeRequestFailureEnum.InvalidTransition,
    );
    expect(ChangeRequestsProvider.undoRefusal(verified({ isUndoable: false }), now)).toBe(
      Schemas.ChangeRequestFailureEnum.NotUndoable,
    );
    for (const overrides of [
      { undoUntil: new Date(now) },
      { undoUntil: null },
      { encryptedChanges: null },
    ]) {
      expect(ChangeRequestsProvider.undoRefusal(verified(overrides), now)).toBe(
        Schemas.ChangeRequestFailureEnum.UndoWindowClosed,
      );
    }
  });

  it("sends a user undo that reached nothing back to Verified, and anything that may have landed to a person", () => {
    for (const outcome of [Outcome.Refused, Outcome.Failed, Outcome.TokenRejected]) {
      expect(ChangeRequestsProvider.undoEnd({ outcome, attempts: 1 }, null, true)).toEqual({
        status: Verified,
        errorCode: null,
      });
    }
    expect(
      ChangeRequestsProvider.undoEnd(
        { outcome: Outcome.Failed, attempts: 1, mayHaveLanded: true },
        null,
        true,
      ),
    ).toEqual({ status: NeedsHuman, errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed });
    expect(
      ChangeRequestsProvider.undoEnd({ outcome: Outcome.Unknown, attempts: 1 }, null, true).status,
    ).toBe(NeedsHuman);
    expect(
      ChangeRequestsProvider.undoEnd({ outcome: Outcome.Succeeded, attempts: 1 }, null, true),
    ).toEqual({
      status: NeedsHuman,
      errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoUnconfirmed,
    });
  });

  it("shows undoUntil only while the user can undo it, and marks an undo under way", () => {
    const payload: Schemas.ChangeRequestPayload = {
      version: 2,
      kind: Schemas.ChangeRequestKindEnum.Update,
      args: { recordId: "rec_alpha", amount: 1 },
      before: null,
      changes: [],
      result: null,
      mismatches: null,
    };
    const open = verified({ undoUntil: new Date(NOW + 60_000) });
    expect(ChangeRequestsProvider.toView(open, payload, NOW).undoUntil).toBe(
      open.undoUntil?.getTime(),
    );
    expect(ChangeRequestsProvider.toView(open, null, NOW).undoUntil).toBeNull();
    const ended = verified({ undoUntil: new Date(NOW - 1) });
    expect(ChangeRequestsProvider.toView(ended, payload, NOW).undoUntil).toBeNull();
    const undoing = ChangeRequestsProvider.toView(
      { ...open, idempotencyKey: undoKey },
      payload,
      NOW,
    );
    expect(undoing).toMatchObject({ undoUntil: null, isUndoing: true });
  });
});

describe("ChangeRequestsProvider who undid it, refusals and undo windows (M3-7)", () => {
  const { Verified, Undone } = Schemas.ChangeRequestStatusIntEnum;
  const userKey = Schemas.changeRequestUserUndoIdempotencyKey("cr_1");
  const autoKey = Schemas.changeRequestUndoIdempotencyKey("cr_1");

  it("reads who undid it from the undo key, which outlives the purge", () => {
    expect(ChangeRequestsProvider.undoneBy(row({ status: Undone, idempotencyKey: userKey }))).toBe(
      Schemas.ChangeRequestUndoneByEnum.User,
    );
    expect(ChangeRequestsProvider.undoneBy(row({ status: Undone, idempotencyKey: autoKey }))).toBe(
      Schemas.ChangeRequestUndoneByEnum.System,
    );
    expect(
      ChangeRequestsProvider.undoneBy(row({ status: Verified, idempotencyKey: userKey })),
    ).toBeNull();
    expect(
      ChangeRequestsProvider.isUserUndoing(row({ status: Verified, idempotencyKey: autoKey })),
    ).toBe(false);
    expect(
      ChangeRequestsProvider.toView(row({ status: Undone, idempotencyKey: userKey }), null, NOW),
    ).toMatchObject({ undoneBy: Schemas.ChangeRequestUndoneByEnum.User, changes: null });
    expect(userKey).toBe(
      `${Schemas.CHANGE_REQUEST_KEY_PREFIX}cr_1${Schemas.CHANGE_REQUEST_USER_UNDO_KEY_SUFFIX}`,
    );
  });

  it("gives up waiting for a cut-short undo a grace period after its window", () => {
    expect(ChangeRequestsProvider.undoGiveUpAt(5_000, NOW)).toBe(
      5_000 + Schemas.CHANGE_REQUEST_UNDO_GRACE_MS,
    );
    expect(ChangeRequestsProvider.undoGiveUpAt(null, NOW)).toBe(
      NOW + Schemas.CHANGE_REQUEST_UNDO_GRACE_MS,
    );
  });

  it("answers each refusal in safe text, ending the window only when it can't be undone at all", () => {
    const F = Schemas.ChangeRequestFailureEnum;
    expect(ChangeRequestsProvider.undoRefusalReply(F.UndoWindowClosed)).toEqual({
      message: "The time to undo this change has passed. Nothing changed.",
      isWindowEnded: true,
      isClosed: false,
    });
    for (const failure of [F.NotFound, F.InvalidTransition, F.NotUndoable]) {
      expect(ChangeRequestsProvider.undoRefusalReply(failure).isWindowEnded).toBe(true);
    }
    for (const failure of [F.ReadOnly, F.ToolUnavailable, F.ChatbotUnavailable, F.ServerError]) {
      expect(ChangeRequestsProvider.undoRefusalReply(failure)).toMatchObject({
        isWindowEnded: false,
        isClosed: false,
      });
    }
    expect(ChangeRequestsProvider.undoRefusalReply(F.ConversationClosed).isClosed).toBe(true);
  });

  it("keeps an undo window by tool call id while the view can be undone, and drops it otherwise", () => {
    const view = { publicId: "cr_1", toolCallId: "call_1", undoUntil: NOW + 1, isUndoing: false };
    const opened = ChangeRequestsProvider.nextUndoWindows({}, view);
    expect(opened).toEqual({ call_1: { publicId: "cr_1", undoUntil: NOW + 1 } });
    expect(ChangeRequestsProvider.nextUndoWindows(opened, { ...view, isUndoing: true })).toBe(
      opened,
    );
    expect(ChangeRequestsProvider.nextUndoWindows(opened, { ...view, undoUntil: null })).toEqual(
      {},
    );
    expect(ChangeRequestsProvider.nextUndoWindows({}, { ...view, toolCallId: null })).toEqual({});
    expect(ChangeRequestsProvider.openUndoWindows(opened, NOW)).toEqual(opened);
    expect(ChangeRequestsProvider.openUndoWindows(opened, NOW + 1)).toEqual({});
  });
});
