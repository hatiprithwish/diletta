import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ChangeRequestTimelineProvider from "@/providers/changeRequestTimeline";

// DEV_NOTE: Unit tests for a change's timeline (M4-5): activity_log events → plain-word steps. No database.

const Action = Schemas.ChangeRequestEntityActionEnum;
const Actor = Schemas.ActivityLogActorTypeIntEnum;
const Tone = Schemas.ChangeRequestTimelineToneEnum;
const START = Date.UTC(2026, 9, 24, 14, 12, 3);

let nextId = 0;
const event = (
  entityAction: string,
  overrides: Partial<Schemas.ActivityLogTimelineRow> = {},
): Schemas.ActivityLogTimelineRow => {
  nextId += 1;
  return {
    id: String(nextId),
    actorType: Actor.System,
    entityAction,
    detail: {},
    createdAt: new Date(START + nextId * 1_000),
    actorName: null,
    ...overrides,
  };
};

const labels = (rows: Schemas.ActivityLogTimelineRow[]) =>
  ChangeRequestTimelineProvider.timeline(rows).map((entry) => entry.label);

describe("ChangeRequestTimelineProvider.timeline", () => {
  it("reads a change that needed a person and was resolved, in order, with names and times", () => {
    const rows = [
      event(Action.Proposed),
      event(Action.Approved, { actorType: Actor.ChatbotUser, actorName: "Priya Shah" }),
      event(Action.Committing),
      event(Action.Committed),
      event(Action.Mismatch),
      event(Action.NeedsHuman, {
        detail: { errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable },
      }),
      event(Action.Resolved, { actorType: Actor.Admin, actorName: "Ana Ruiz" }),
    ];
    const timeline = ChangeRequestTimelineProvider.timeline(rows);

    expect(timeline.map((entry) => entry.label)).toEqual([
      "Proposed",
      "Approved by Priya Shah",
      "Saving in your app",
      "Saved in your app",
      "Check failed: your app shows other values",
      "Needs a person: the check failed and the tool can't undo",
      "Marked resolved by Ana Ruiz",
    ]);
    expect(timeline.map((entry) => entry.tone)).toEqual([
      Tone.Neutral,
      Tone.Success,
      Tone.Neutral,
      Tone.Success,
      Tone.Destructive,
      Tone.Destructive,
      Tone.Success,
    ]);
    expect(timeline[0]!.createdAt).toBe(rows[0]!.createdAt.toISOString());
  });

  it("tells an automatic approval, a retried save and the user's own undo apart", () => {
    expect(
      labels([
        event(Action.Approved, { detail: { isAutomatic: true } }),
        event(Action.Committing),
        event(Action.Committing),
        event(Action.Verified),
        event(Action.Undoing, {
          actorType: Actor.ChatbotUser,
          actorName: "Priya Shah",
          detail: { isUserUndo: true },
        }),
        event(Action.Undone, { actorType: Actor.ChatbotUser, actorName: "Priya Shah" }),
      ]),
    ).toEqual([
      "Approved automatically",
      "Saving in your app",
      "Saving in your app again",
      "Checked: your app shows the change",
      "Undo asked by Priya Shah",
      "Undone by Priya Shah",
    ]);
    expect(labels([event(Action.Undoing), event(Action.Undone)])).toEqual([
      "Undoing the change",
      "Changes undone",
    ]);
  });

  it("names who acted when the name is unknown, and reads a reason from an older event", () => {
    expect(
      labels([
        event(Action.Edited, { actorType: Actor.ChatbotUser }),
        event(Action.Rejected, { actorType: Actor.ChatbotUser }),
        event(Action.Resolved, { actorType: Actor.Admin }),
        event(Action.Failed, {
          detail: { reason: Schemas.ChangeRequestErrorCodeEnum.HostRefused },
        }),
      ]),
    ).toEqual([
      "Edited by the user",
      "Rejected by the user",
      "Marked resolved by an admin",
      "Not saved: your app refused the change",
    ]);
  });

  it("reads an unreadable detail as empty, an unknown code as ours, and leaves out unknown actions", () => {
    expect(
      labels([
        event(Action.Expired, { detail: "not an object" }),
        event(Action.NeedsHuman, { detail: { errorCode: "renamed_code" } }),
        event(Action.NeedsHuman, { detail: { isAutomatic: "yes" } }),
        event("archived"),
        event(Action.UndoNotSent),
      ]),
    ).toEqual([
      "Expired before anyone approved it",
      "Needs a person: something went wrong on our side",
      "Needs a person",
      "Undo not sent. Nothing changed",
    ]);
  });
});
