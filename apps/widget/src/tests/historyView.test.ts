import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import { pastChatMeta, toHistoryView } from "@/lib/historyView";

// DEV_NOTE: Your chats as the screen shows them: day groups in the visitor's time zone, each row's line, Show more
const NOW = new Date(2026, 10, 7, 12, 0);
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();
const item = (
  publicId: string,
  lastActivityAt: string,
  isOpen = false,
): Schemas.WidgetConversationListItem => ({
  publicId,
  title: `Chat ${publicId}`,
  isOpen,
  lastActivityAt,
});
const ready = (
  items: Schemas.WidgetConversationListItem[],
  totalRecords = items.length,
): Schemas.WidgetHistoryState => ({
  status: "ready",
  items,
  totalRecords,
  isLoadingMore: false,
  moreFailed: false,
});

describe("toHistoryView", () => {
  it("groups by day and words each row: current, ongoing or ended", () => {
    const view = toHistoryView({
      state: ready([
        item("a", at(7, 10, 42), true),
        item("b", at(7, 9, 14)),
        item("c", at(6, 16, 5), true),
        item("d", at(3, 18, 0)),
        item("e", new Date(2025, 9, 30, 9, 0).toISOString()),
      ]),
      currentPublicId: "a",
      now: NOW,
      locale: "en-GB",
    });
    if (view.status !== "ready") throw new Error("Expected ready");
    expect(view.groups.map((group) => [group.label, group.rows.map((row) => row.meta)])).toEqual([
      ["Today", ["Current chat · 10:42", "Ended · 09:14"]],
      ["Yesterday", ["Ongoing · 16:05"]],
      ["Earlier", ["Ended · 3 Nov", "Ended · 30 Oct 2025"]],
    ]);
    expect(view.groups[0]!.rows[0]!.tone).toBe(Schemas.WidgetHistoryToneEnum.Current);
    expect(view.hasMore).toBe(false);
  });

  it("offers more while fewer rows are read than there are", () => {
    const view = toHistoryView({
      state: ready([item("a", at(7, 9))], 21),
      currentPublicId: null,
      now: NOW,
    });
    expect(view.status === "ready" && view.hasMore).toBe(true);
  });

  it("passes loading and failed through", () => {
    for (const state of [{ status: "loading" }, { status: "failed" }] as const) {
      expect(toHistoryView({ state, currentPublicId: null, now: NOW })).toEqual(state);
    }
  });
});

describe("pastChatMeta", () => {
  it("says when it ended: today and yesterday with the time, else the date", () => {
    expect(pastChatMeta(item("a", at(7, 9, 14)), NOW, "en-GB")).toBe("Ended · Today, 09:14");
    expect(pastChatMeta(item("b", at(6, 16, 5)), NOW, "en-GB")).toBe("Ended · Yesterday, 16:05");
    expect(pastChatMeta(item("c", at(3, 18)), NOW, "en-GB")).toBe("Ended · 3 Nov");
  });
});
