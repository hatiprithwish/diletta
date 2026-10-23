import { describe, it, expect } from "vitest";
import {
  ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS,
  activityRollupDayCount,
  activityRollupDayKey,
  activityRollupDayRange,
  activityRollupDays,
  activityRollupAddDays,
  activityRollupRecentDays,
  ActivityRollupMetricKindEnum,
  ActivityRollupModelCallMeasureEnum,
  ActivityRollupModelCallScopeEnum,
  changeRequestRollupMetric,
  changeRequestUserUndoRollupMetric,
  conversationOutcomeMetric,
  modelCallModelRollupMetric,
  modelCallTaskRollupMetric,
  parseActivityRollupMetric,
  ACTIVITY_ROLLUP_CONVERSATIONS_STARTED,
  ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP,
} from "./ActivityRollupsCommon";
import { ChangeRequestEntityActionEnum } from "../changeRequests";
import { FeedbackRatingIntEnum } from "../feedback";
import { PlatformModelProviderEnum } from "../modelCalls";
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

  it("counts the days of a range arithmetically", () => {
    expect(activityRollupDayCount("2026-10-12", "2026-10-12")).toBe(1);
    expect(activityRollupDayCount("2026-09-01", "2026-10-01")).toBe(31);
    expect(activityRollupDayCount("2026-10-13", "2026-10-12")).toBe(0);
    expect(activityRollupDayCount("0001-01-01", "2026-10-12")).toBeGreaterThan(700_000);
  });

  it("names yesterday and today (UTC) as the recent days", () => {
    expect(activityRollupRecentDays(Date.parse("2026-11-01T00:30:00Z"))).toEqual([
      "2026-10-31",
      "2026-11-01",
    ]);
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
      { fromDay: "0001-01-01", toDay: "2026-10-12" },
      { fromDay: "2026-02-30", toDay: "2026-03-01" },
      { fromDay: "12/10/2026", toDay: "2026-10-12" },
    ]) {
      expect(ZRebuildActivityRollupsApiRequest.safeParse(range).success).toBe(false);
    }
  });
});

describe("activity rollup metric keys, read back", () => {
  const { Live, Eval } = ActivityRollupModelCallScopeEnum;
  const { CostUsd, Count } = ActivityRollupModelCallMeasureEnum;

  it("parses every key the builders make", () => {
    expect(parseActivityRollupMetric(ACTIVITY_ROLLUP_CONVERSATIONS_STARTED)).toEqual({
      kind: ActivityRollupMetricKindEnum.ConversationsStarted,
    });
    expect(
      parseActivityRollupMetric(conversationOutcomeMetric(ConversationOutcomeIntEnum.Handoff)),
    ).toEqual({
      kind: ActivityRollupMetricKindEnum.ConversationOutcome,
      outcome: ConversationOutcomeIntEnum.Handoff,
    });
    expect(
      parseActivityRollupMetric(ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[FeedbackRatingIntEnum.Down]),
    ).toEqual({ kind: ActivityRollupMetricKindEnum.Feedback, rating: FeedbackRatingIntEnum.Down });
    expect(
      parseActivityRollupMetric(
        changeRequestRollupMetric(ChangeRequestEntityActionEnum.NeedsHuman, "update_record"),
      ),
    ).toEqual({
      kind: ActivityRollupMetricKindEnum.ChangeRequest,
      action: ChangeRequestEntityActionEnum.NeedsHuman,
      toolName: "update_record",
    });
    expect(parseActivityRollupMetric(changeRequestUserUndoRollupMetric("update_record"))).toEqual({
      kind: ActivityRollupMetricKindEnum.ChangeRequestUserUndone,
      toolName: "update_record",
    });
    expect(parseActivityRollupMetric(modelCallTaskRollupMetric(Eval, Count, "eval.judge"))).toEqual(
      {
        kind: ActivityRollupMetricKindEnum.ModelCallTask,
        scope: Eval,
        measure: Count,
        taskType: "eval.judge",
      },
    );
    expect(
      parseActivityRollupMetric(
        modelCallModelRollupMetric(
          Live,
          CostUsd,
          PlatformModelProviderEnum.WorkersAi,
          "@cf/baai/bge-m3",
        ),
      ),
    ).toEqual({
      kind: ActivityRollupMetricKindEnum.ModelCallModel,
      scope: Live,
      measure: CostUsd,
      provider: "workers_ai",
      model: "@cf/baai/bge-m3",
    });
  });

  it("returns null for a key no builder makes", () => {
    for (const metric of [
      "conversations.outcome.unknown",
      "change_requests.proposed.tool.update_record",
      "change_requests.verified.tool.",
      "change_requests.user_undone.tool.",
      "model_calls.latency.task.qa.answer",
      "model_calls.count.model.anthropic",
      "model_calls.count.other.x",
      "something.else",
    ]) {
      expect(parseActivityRollupMetric(metric)).toBeNull();
    }
  });

  it("adds days across a month end", () => {
    expect(activityRollupAddDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(activityRollupAddDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
