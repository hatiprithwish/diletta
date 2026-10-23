import { describe, it, expect } from "vitest";
import {
  ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS,
  activityRollupDayKey,
  activityRollupDayRange,
  activityRollupDays,
  conversationOutcomeMetric,
} from "./ActivityRollupsCommon";
import { ZRebuildActivityRollupsApiRequest } from "./ActivityRollupsApiRequest";
import { ConversationOutcomeIntEnum } from "../conversations";

describe("activity rollup days", () => {
  it("keys an instant by its UTC day", () => {
    expect(activityRollupDayKey(Date.parse("2026-10-12T23:59:59.999Z"))).toBe("2026-10-12");
    expect(activityRollupDayKey(Date.parse("2026-10-13T00:30:00+05:30"))).toBe("2026-10-12");
  });

  it("covers a day as a half-open UTC range", () => {
    expect(activityRollupDayRange("2026-10-12")).toEqual({
      start: new Date("2026-10-12T00:00:00.000Z"),
      end: new Date("2026-10-13T00:00:00.000Z"),
    });
  });

  it("lists every day of a range, across a month end", () => {
    expect(activityRollupDays("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(activityRollupDays("2026-10-12", "2026-10-12")).toEqual(["2026-10-12"]);
  });

  it("names outcomes with stable keys", () => {
    expect(conversationOutcomeMetric(ConversationOutcomeIntEnum.ActionDone)).toBe(
      "conversations.outcome.action_done",
    );
  });
});

describe("ZRebuildActivityRollupsApiRequest", () => {
  it("takes a range of up to the cap, today included", () => {
    const today = activityRollupDayKey(Date.now());
    expect(
      ZRebuildActivityRollupsApiRequest.safeParse({ fromDay: today, toDay: today }).success,
    ).toBe(true);
    expect(
      ZRebuildActivityRollupsApiRequest.safeParse({ fromDay: "2026-09-01", toDay: "2026-10-01" })
        .success,
    ).toBe(true);
    expect(ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS).toBe(31);
  });

  it("refuses a reversed, oversized, future or malformed range", () => {
    for (const range of [
      { fromDay: "2026-10-13", toDay: "2026-10-12" },
      { fromDay: "2026-09-01", toDay: "2026-10-02" },
      { fromDay: "2026-10-01", toDay: "2999-01-01" },
      { fromDay: "2026-02-30", toDay: "2026-03-01" },
      { fromDay: "12/10/2026", toDay: "2026-10-12" },
    ]) {
      expect(ZRebuildActivityRollupsApiRequest.safeParse(range).success).toBe(false);
    }
  });
});
