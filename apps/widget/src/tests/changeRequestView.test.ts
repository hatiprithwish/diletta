import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";
import {
  displayValue,
  groupChangeRequests,
  parseEditText,
  toChangeCard,
} from "@/lib/changeRequestView";
import { toMessageViews } from "@/lib/transcriptView";
import { EMPTY_REVIEW } from "@/store/widgetStore";

// DEV_NOTE: The review cards (M3-5) from the transcript and the DO's change_request frames
const AMOUNT: Schemas.ChangeRequestEditableField = {
  field: "amount",
  type: Schemas.ChangeRequestFieldTypeEnum.Number,
  enumValues: null,
  format: null,
  isRequired: false,
};

function changeRequest(
  publicId: string,
  patch: Partial<Schemas.WidgetChangeRequest> = {},
): Schemas.WidgetChangeRequest {
  return {
    publicId,
    toolName: "update_record",
    toolCallId: `call-${publicId}`,
    kind: Schemas.ChangeRequestKindEnum.Update,
    changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Proposed,
    changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.Proposed,
    summary: "update_record: 1 field changed",
    changes: [
      {
        field: "amount",
        before: { isFound: true, value: 120 },
        after: { isFound: true, value: 300 },
        isChanged: true,
      },
      {
        field: "recordId",
        before: { isFound: true, value: `rec_${publicId}` },
        after: { isFound: true, value: `rec_${publicId}` },
        isChanged: false,
      },
    ],
    changeCount: 1,
    expiresAt: 1_000,
    isUndoable: true,
    wasEdited: false,
    editableFields: [AMOUNT],
    mismatches: null,
    ...patch,
  };
}

const toolPart = (toolCallId: string, output: unknown) =>
  ({
    type: "tool-update_record",
    toolCallId,
    state: "output-available",
    input: {},
    output,
  }) as UIMessage["parts"][number];

const transcript = (parts: UIMessage["parts"]): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Update them" }] },
  { id: "a1", role: "assistant", parts },
];

const review = (
  members: Schemas.WidgetChangeRequest[],
  patch: Partial<Schemas.WidgetChangeReviewState> = {},
): Schemas.WidgetChangeReviewState => ({
  ...EMPTY_REVIEW,
  changeRequests: Object.fromEntries(members.map((member) => [member.publicId, member])),
  ...patch,
});

describe("groupChangeRequests", () => {
  it("puts a change request in the reply that made its call, by tool call id or by the call's output", () => {
    const messages = transcript([
      toolPart("call-a", { status: "paused", executionId: "x" }),
      toolPart("call-done", {
        status: Schemas.HostToolStatusEnum.Committed,
        message: "The change was made in the app.",
        changeRequestId: "b",
      }),
    ]);
    const groups = groupChangeRequests(
      messages,
      review([changeRequest("a"), changeRequest("b", { toolCallId: null })]).changeRequests,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messageId).toBe("a1");
    expect(groups[0]?.members.map((member) => member.publicId)).toEqual(["a", "b"]);
  });

  it("keeps different tools or kinds in their own cards", () => {
    const groups = groupChangeRequests(
      transcript([]),
      review([
        changeRequest("a"),
        changeRequest("b", { kind: Schemas.ChangeRequestKindEnum.Create }),
        changeRequest("c", { toolName: "delete_record" }),
      ]).changeRequests,
    );
    expect(groups).toHaveLength(3);
  });
});

describe("toChangeCard", () => {
  const group = (members: Schemas.WidgetChangeRequest[]) => ({
    messageId: "a1",
    cardId: "card",
    members,
  });

  it("shows a card with each record's id and its changed fields, ready to approve", () => {
    const members = [changeRequest("a"), changeRequest("b")];
    const card = toChangeCard(group(members), review(members));
    expect(card).toMatchObject({
      layout: Schemas.WidgetChangeCardLayoutEnum.Card,
      stage: Schemas.WidgetChangeCardStageEnum.Review,
      title: "Update 2 records",
      approveLabel: "Approve 2 changes",
      canEdit: true,
      expiresAt: 1_000,
    });
    expect(card.records[0]).toMatchObject({
      label: "rec_a",
      lines: [{ field: "amount", before: "120", after: "300", isChanged: true }],
    });
  });

  it("turns more than three records into the bulk table, counting the unticked ones out", () => {
    const members = Array.from({ length: 8 }, (_, index) => changeRequest(`r${index}`));
    const card = toChangeCard(group(members), review(members, { excluded: { r1: true } }));
    expect(card.layout).toBe(Schemas.WidgetChangeCardLayoutEnum.Bulk);
    expect(card.title).toBe("Update 7 of 8 records");
    expect(card.subtitle).toBe("amount only. You unticked 1 record.");
    expect(card.approveLabel).toBe("Approve 7 changes");
    expect(card.records).toHaveLength(Schemas.WIDGET_CHANGE_BULK_VISIBLE_ROWS);
    expect(card.hiddenCount).toBe(2);
    expect(card.canEdit).toBe(false);
  });

  it("settles once nothing is Proposed, with each record's outcome", () => {
    const members = [
      changeRequest("a", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Committed,
        editableFields: [],
      }),
      changeRequest("b", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Rejected,
        editableFields: [],
      }),
    ];
    const card = toChangeCard(group(members), review(members, { sending: { card: true } }));
    expect(card.stage).toBe(Schemas.WidgetChangeCardStageEnum.Settled);
    expect(card.isSending).toBe(false);
    expect(card.subtitle).toBe("1 saved, 1 rejected.");
    expect(card.records.map((record) => record.outcome)).toEqual([
      Schemas.WidgetChangeOutcomeEnum.Saved,
      Schemas.WidgetChangeOutcomeEnum.Rejected,
    ]);
  });

  it("says every record was saved and checked once all are Verified", () => {
    const members = ["a", "b"].map((id) =>
      changeRequest(id, {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Verified,
        editableFields: [],
      }),
    );
    const card = toChangeCard(group(members), review(members));
    expect(card.tone).toBe(Schemas.WidgetChangeCardToneEnum.Verified);
    expect(card.title).toBe("2 records updated");
    expect(card.subtitle).toBe("Saved and checked: each record matches the change.");
    expect(card.mismatchLines).toEqual([]);
    expect(card.records.map((record) => record.outcome)).toEqual([
      Schemas.WidgetChangeOutcomeEnum.Verified,
      Schemas.WidgetChangeOutcomeEnum.Verified,
    ]);
  });

  it("shows what the check found for an undone record, and keeps the checked one", () => {
    const members = [
      changeRequest("a", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Verified,
        editableFields: [],
      }),
      changeRequest("b", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Undone,
        editableFields: [],
        mismatches: [
          {
            field: "amount",
            expected: { isFound: true, value: 300 },
            found: { isFound: true, value: 999 },
          },
        ],
      }),
    ];
    const card = toChangeCard(group(members), review(members));
    expect(card.tone).toBe(Schemas.WidgetChangeCardToneEnum.Undone);
    expect(card.title).toBe("Change undone");
    expect(card.subtitle).toBe("The app didn't save rec_b as expected, so I undid it.");
    expect(card.notes).toEqual(["rec_a was saved and checked."]);
    expect(card.mismatchLines).toEqual([
      { label: "rec_b", field: "amount", expected: "300", found: "999" },
    ]);
  });

  it("says nothing changed when the only record was undone", () => {
    const members = [
      changeRequest("a", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Undone,
        editableFields: [],
      }),
    ];
    const card = toChangeCard(group(members), review(members));
    expect(card.subtitle).toBe(
      "The app didn't save rec_a as expected, so I undid it. Nothing changed.",
    );
  });

  it("leads with the record that needs a person, and names the saved ones", () => {
    const members = [
      changeRequest("a", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Verified,
        editableFields: [],
      }),
      changeRequest("b", {
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        editableFields: [],
      }),
    ];
    const card = toChangeCard(group(members), review(members));
    expect(card.tone).toBe(Schemas.WidgetChangeCardToneEnum.NeedsPerson);
    expect(card.title).toBe("This change needs a person");
    expect(card.subtitle).toBe("I couldn't confirm rec_b saved correctly.");
    expect(card.notes).toEqual([
      "rec_a was saved and checked.",
      "rec_b is flagged for your team. Please leave it as is until they review it.",
    ]);
  });

  it("shows a delete the check found still there", () => {
    const members = [
      changeRequest("a", {
        kind: Schemas.ChangeRequestKindEnum.Delete,
        changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Undone,
        editableFields: [],
        mismatches: [
          {
            field: "recordId",
            expected: { isFound: false },
            found: { isFound: true, value: "rec_a" },
          },
        ],
      }),
    ];
    const card = toChangeCard(group(members), review(members));
    expect(card.mismatchLines).toEqual([
      { label: "rec_a", field: "recordId", expected: "Deleted", found: "Still there" },
    ]);
  });

  it("shows the editor with the draft over the proposed value", () => {
    const members = [changeRequest("a")];
    const card = toChangeCard(
      group(members),
      review(members, { editing: { card: { a: { amount: "450" } } } }),
    );
    expect(card.stage).toBe(Schemas.WidgetChangeCardStageEnum.Editing);
    expect(card.title).toBe("Editing 1 change");
    expect(card.records[0]?.editFields).toEqual([
      { field: "amount", value: "450", editable: AMOUNT },
    ]);
  });
});

describe("toMessageViews with change requests", () => {
  it("adds the cards to their reply and labels a paused write as waiting", () => {
    const messages = transcript([toolPart("call-a", { status: "paused", executionId: "x" })]);
    const [, assistant] = toMessageViews({
      messages,
      isStreaming: false,
      ratings: {},
      pendingRatings: {},
      review: review([changeRequest("a")]),
    });
    if (assistant?.role !== "assistant") throw new Error("No reply");
    expect(assistant.changeCards).toHaveLength(1);
    expect(assistant.steps[0]?.label).toBe("Waiting for your approval");
  });
});

describe("displayValue and parseEditText", () => {
  it("shows a plain date as day month year, and an absent value as empty", () => {
    expect(displayValue({ isFound: true, value: "2026-09-22" })).toBe("22 Sep 2026");
    expect(displayValue({ isFound: false })).toBeNull();
    expect(displayValue({ isFound: true, value: null })).toBeNull();
  });

  it("parses the editor's text to the field's type, refusing what can't fit", () => {
    expect(parseEditText(AMOUNT, "12.5")).toEqual({ isValid: true, value: 12.5 });
    expect(parseEditText(AMOUNT, "lots").isValid).toBe(false);
    expect(
      parseEditText({ ...AMOUNT, type: Schemas.ChangeRequestFieldTypeEnum.Integer }, "1.5"),
    ).toEqual({ isValid: false });
    expect(
      parseEditText({ ...AMOUNT, type: Schemas.ChangeRequestFieldTypeEnum.Boolean }, "true"),
    ).toEqual({ isValid: true, value: true });
    expect(parseEditText({ ...AMOUNT, enumValues: [1, 2] }, "2")).toEqual({
      isValid: true,
      value: 2,
    });
  });
});
