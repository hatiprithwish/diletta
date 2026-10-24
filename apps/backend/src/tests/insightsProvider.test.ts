import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ActivityRollupsProvider from "@/providers/activityRollups";
import InsightsProvider from "@/providers/insights";

// DEV_NOTE: Unit tests for the Insights pages' numbers (M4-3): no database. Readings are built by the rollup itself
// (ActivityRollupsProvider.buildValues, company-wide rows), so the pages read the exact keys the rollup writes.

const { QaAnswer, RouteIntent, EvalJudge, SearchEmbed } = Schemas.ModelTaskTypeEnum;
const anthropic = Schemas.ModelProviderEnum.Anthropic;
const workersAi = Schemas.PlatformModelProviderEnum.WorkersAi;
const Outcome = Schemas.ConversationOutcomeIntEnum;
const Action = Schemas.ChangeRequestEntityActionEnum;

type DaySources = Partial<Parameters<typeof ActivityRollupsProvider.buildValues>[0]>;

function readingsOf(days: Record<string, DaySources>): Schemas.ActivityRollupReading[] {
  return Object.entries(days).flatMap(([day, sources]) =>
    ActivityRollupsProvider.buildValues({
      conversations: [],
      feedback: [],
      changeRequests: [],
      modelCalls: [],
      ...sources,
    })
      .filter((value) => value.chatbotId === null)
      .map((value) => ({ day, metric: value.metric, value: value.value })),
  );
}

const modelCall = (
  overrides: Partial<Schemas.ModelCallRollupGroup>,
): Schemas.ModelCallRollupGroup => ({
  chatbotId: "1",
  isEval: false,
  taskType: QaAnswer,
  provider: anthropic,
  model: "claude-sonnet-5-5",
  count: 1,
  inputTokens: "0",
  outputTokens: "0",
  costUsd: "0.000000",
  ...overrides,
});

const periods: Schemas.InsightsPeriods = {
  current: { fromDay: "2026-10-20", toDay: "2026-10-22" },
  previous: { fromDay: "2026-10-17", toDay: "2026-10-19" },
};

const attention: Schemas.InsightsOverviewAttention = {
  needsHumanCount: 1,
  openIssueCount: 2,
  openUserIssueCount: 1,
  failedSourceCount: 0,
  lastSourceFailedAt: null,
};

describe("InsightsProvider.buildOverview", () => {
  const readings = InsightsProvider.indexReadings(
    readingsOf({
      "2026-10-18": {
        conversations: [{ chatbotId: "1", outcome: Outcome.Answered, count: 1 }],
      },
      "2026-10-20": {
        conversations: [
          { chatbotId: "1", outcome: Outcome.Answered, count: 3 },
          { chatbotId: "1", outcome: Outcome.Handoff, count: 1 },
          { chatbotId: "1", outcome: Outcome.Abandoned, count: 2 },
        ],
        feedback: [
          { chatbotId: "1", rating: Schemas.FeedbackRatingIntEnum.Up, count: 3 },
          { chatbotId: "1", rating: Schemas.FeedbackRatingIntEnum.Down, count: 1 },
        ],
        changeRequests: [
          {
            chatbotId: "1",
            action: Action.Verified,
            toolName: "update_record",
            isByChatbotUser: false,
            count: 4,
          },
          {
            chatbotId: "1",
            action: Action.Undone,
            toolName: "update_record",
            isByChatbotUser: true,
            count: 1,
          },
          {
            chatbotId: "1",
            action: Action.NeedsHuman,
            toolName: "update_record",
            isByChatbotUser: false,
            count: 1,
          },
        ],
      },
      "2026-10-22": {
        conversations: [{ chatbotId: "1", outcome: null, count: 2 }],
        modelCalls: [
          modelCall({ costUsd: "0.100000" }),
          modelCall({ isEval: true, taskType: EvalJudge, costUsd: "0.020000" }),
          modelCall({
            taskType: SearchEmbed,
            provider: workersAi,
            model: "@cf/baai/bge-m3",
            costUsd: "0.000300",
          }),
        ],
      },
    }),
  );
  const overview = InsightsProvider.buildOverview({
    periods,
    index: readings,
    monthIndex: readings,
    month: { fromDay: "2026-10-01", toDay: "2026-10-22", resetsOnDay: "2026-11-01" },
    budgetUsd: "10.000000",
    attention,
    liveConfig: null,
  });

  it("counts conversations against the previous period, day by day", () => {
    expect(overview.conversations).toEqual({ value: 8, previousValue: 1 });
    expect(overview.conversationsPerDay).toEqual([
      { day: "2026-10-20", value: 6 },
      { day: "2026-10-21", value: 0 },
      { day: "2026-10-22", value: 2 },
    ]);
  });

  it("leaves abandoned conversations out of the answered rate", () => {
    expect(overview.answeredRate).toEqual({ value: 0.75, previousValue: 1 });
  });

  it("rates helpful replies and counts change outcomes", () => {
    expect(overview.helpfulRate).toEqual({ value: 0.75, ratedCount: 4 });
    expect(overview.changes).toEqual({ verified: 4, undone: 1, needsHuman: 1 });
  });

  it("spends only what the company's key paid, test runs included", () => {
    expect(overview.monthSpend).toEqual({
      fromDay: "2026-10-01",
      resetsOnDay: "2026-11-01",
      spentUsd: "0.120000",
      testRunsUsd: "0.020000",
      budgetUsd: "10.000000",
    });
  });

  it("has no rate with nothing to divide by", () => {
    const empty = InsightsProvider.buildOverview({
      periods,
      index: new Map(),
      monthIndex: new Map(),
      month: { fromDay: "2026-10-01", toDay: "2026-10-22", resetsOnDay: "2026-11-01" },
      budgetUsd: "10.000000",
      attention,
      liveConfig: null,
    });
    expect(empty.answeredRate).toEqual({ value: null, previousValue: null });
    expect(empty.helpfulRate).toEqual({ value: null, ratedCount: 0 });
  });
});

describe("InsightsProvider.buildUsage", () => {
  const readings = InsightsProvider.indexReadings(
    readingsOf({
      "2026-10-19": { modelCalls: [modelCall({ costUsd: "1.000000" })] },
      "2026-10-20": {
        conversations: [{ chatbotId: "1", outcome: null, count: 3 }],
        modelCalls: [
          modelCall({ count: 2, inputTokens: "100", outputTokens: "40", costUsd: "0.300001" }),
          modelCall({
            taskType: RouteIntent,
            inputTokens: "10",
            outputTokens: "1",
            costUsd: "0.000001",
          }),
          modelCall({ isEval: true, taskType: EvalJudge, count: 3, costUsd: "0.050000" }),
          // DEV_NOTE: An eval run's search: Search (Included), not a test run
          modelCall({
            isEval: true,
            taskType: SearchEmbed,
            provider: workersAi,
            model: "@cf/baai/bge-m3",
            costUsd: "0.000100",
          }),
          modelCall({
            chatbotId: null,
            taskType: SearchEmbed,
            provider: workersAi,
            model: "@cf/baai/bge-m3",
            count: 5,
            inputTokens: "30",
            outputTokens: "0",
            costUsd: "0.000200",
          }),
        ],
      },
    }),
  );
  const usage = InsightsProvider.buildUsage({ periods, index: readings });

  it("totals spend exactly, without platform-paid calls", () => {
    expect(usage.spend).toEqual({
      valueUsd: "0.350002",
      previousValueUsd: "1.000000",
      testRunsUsd: "0.050000",
    });
    expect(usage.modelCalls).toEqual({ value: 12, previousValue: 1 });
    expect(usage.spendPerDay.map((day) => day.costUsd)).toEqual([
      "0.350002",
      "0.000000",
      "0.000000",
    ]);
  });

  it("divides live spend by conversations, rounded to the micro-dollar", () => {
    // (0.300001 + 0.000001) / 3 = 0.100000666… → 0.100001
    expect(usage.costPerConversation).toEqual({ valueUsd: "0.100001", previousValueUsd: null });
  });

  it("groups calls by use, so the paid rows add up to the spend", () => {
    expect(usage.byUse).toEqual([
      {
        use: "answers",
        useLabel: "Answers",
        calls: 2,
        tokens: 140,
        costUsd: "0.300001",
        isIncluded: false,
      },
      {
        use: "routing",
        useLabel: "Routing",
        calls: 1,
        tokens: 11,
        costUsd: "0.000001",
        isIncluded: false,
      },
      {
        use: "test_runs",
        useLabel: "Test runs (incl. judge)",
        calls: 3,
        tokens: 0,
        costUsd: "0.050000",
        isIncluded: false,
      },
      {
        use: "search",
        useLabel: "Search embeddings + rerank",
        calls: 6,
        tokens: 30,
        costUsd: "0.000300",
        isIncluded: true,
      },
    ]);
  });

  it("lists models by cost", () => {
    expect(usage.byModel).toEqual([
      {
        provider: "anthropic",
        providerLabel: "Anthropic",
        model: "claude-sonnet-5-5",
        calls: 6,
        costUsd: "0.350002",
        isIncluded: false,
      },
      {
        provider: "workers_ai",
        providerLabel: "Cloudflare Workers AI",
        model: "@cf/baai/bge-m3",
        calls: 6,
        costUsd: "0.000300",
        isIncluded: true,
      },
    ]);
  });
});

describe("InsightsProvider.buildImpact", () => {
  const impactPeriods: Schemas.InsightsPeriods = {
    current: { fromDay: "2026-10-01", toDay: "2026-10-22" },
    previous: { fromDay: "2026-09-01", toDay: "2026-09-22" },
  };
  const readings = InsightsProvider.indexReadings(
    readingsOf({
      "2026-09-10": {
        conversations: [{ chatbotId: "1", outcome: Outcome.Answered, count: 6 }],
      },
      "2026-10-05": {
        conversations: [{ chatbotId: "1", outcome: Outcome.Answered, count: 12 }],
        changeRequests: [
          {
            chatbotId: "1",
            action: Action.Verified,
            toolName: "update_record",
            isByChatbotUser: false,
            count: 10,
          },
          // DEV_NOTE: Undone within its hour, so on the same day
          {
            chatbotId: "1",
            action: Action.Verified,
            toolName: "old_tool",
            isByChatbotUser: false,
            count: 2,
          },
          {
            chatbotId: "1",
            action: Action.Undone,
            toolName: "old_tool",
            isByChatbotUser: true,
            count: 4,
          },
        ],
      },
      "2026-10-20": {
        changeRequests: [
          {
            chatbotId: "1",
            action: Action.Verified,
            toolName: "update_record",
            isByChatbotUser: false,
            count: 5,
          },
          {
            chatbotId: "1",
            action: Action.Undone,
            toolName: "update_record",
            isByChatbotUser: true,
            count: 3,
          },
          // DEV_NOTE: Auto-undos of mismatches: never verified, so they take nothing off
          {
            chatbotId: "1",
            action: Action.Undone,
            toolName: "update_record",
            isByChatbotUser: false,
            count: 7,
          },
        ],
      },
    }),
  );
  const created = new Date("2026-10-01T00:00:00Z");
  const impact = InsightsProvider.buildImpact({
    periods: impactPeriods,
    index: readings,
    roiAssumptions: [
      {
        taskType: "answers",
        manualMinutes: "5.0",
        effectiveFrom: "2026-10-01",
        createdAt: created,
      },
      {
        taskType: "tool:update_record",
        manualMinutes: "6.0",
        effectiveFrom: "2026-10-01",
        createdAt: created,
      },
      // DEV_NOTE: From the 15th, an update takes 3 minutes: the 5th keeps 6
      {
        taskType: "tool:update_record",
        manualMinutes: "3.0",
        effectiveFrom: "2026-10-15",
        createdAt: created,
      },
      {
        taskType: "tool:old_tool",
        manualMinutes: "30.0",
        effectiveFrom: "2026-10-01",
        createdAt: created,
      },
    ],
    writeTools: [
      { name: "update_record", description: "Update a record" },
      { name: "close_inspection", description: "Close an inspection" },
    ],
    now: Date.parse("2026-10-22T12:00:00Z"),
  });

  it("values each day's net work at the minutes in force that day", () => {
    const byType = Object.fromEntries(impact.tasks.map((task) => [task.taskType, task]));
    expect(byType["answers"]).toMatchObject({ count: 12, manualMinutes: "5.0", hoursSaved: 1 });
    // 10 × 6 min + (5 − 3 user undos) × 3 min = 66 min; the 7 auto-undos take nothing off
    expect(byType["tool:update_record"]).toMatchObject({
      kind: Schemas.ImpactTaskKindEnum.Tool,
      label: "Update a record",
      count: 12,
      manualMinutes: "3.0",
      hoursSaved: 1.1,
    });
    // 2 − 4 = −2: never below zero; the retired tool keeps its name as label
    expect(byType["tool:old_tool"]).toMatchObject({ label: "old_tool", count: 0, hoursSaved: 0 });
    expect(byType["tool:close_inspection"]).toMatchObject({
      count: 0,
      manualMinutes: null,
      hoursSaved: 0,
    });
  });

  it("totals hours, tasks and working days", () => {
    expect(impact.hoursSaved).toEqual({ value: 2.1, previousValue: 0.5 });
    expect(impact.tasksDone).toBe(24);
    expect(impact.workingDays).toBe(16);
    expect(impact.hoursPerWorkingDay).toBe(0.13);
  });

  it("buckets hours by week, cut to the range", () => {
    expect(impact.hoursPerWeek).toEqual([
      { weekStartDay: "2026-09-28", hours: 0 },
      { weekStartDay: "2026-10-05", hours: 2 },
      { weekStartDay: "2026-10-12", hours: 0 },
      { weekStartDay: "2026-10-19", hours: 0.1 },
    ]);
  });
});

describe("InsightsProvider weekly hours", () => {
  it("spreads a week's undos onto earlier weeks, keeping the range total", () => {
    expect(InsightsProvider.spreadWeeks([10, -5])).toEqual([5, 0]);
    expect(InsightsProvider.spreadWeeks([-5, 10])).toEqual([0, 5]);
    expect(InsightsProvider.spreadWeeks([3, -1, 2, -4])).toEqual([0, 0, 0, 0]);
    expect(InsightsProvider.spreadWeeks([3, -1, 4, -2])).toEqual([2, 0, 2, 0]);
    expect(InsightsProvider.spreadWeeks([-2, 1])).toEqual([0, 0]);
    expect(InsightsProvider.spreadWeeks([])).toEqual([]);
  });

  it("adds the weekly bars up to the range's time saved when an undo lands a week later", () => {
    const impact = InsightsProvider.buildImpact({
      periods: {
        current: { fromDay: "2026-10-05", toDay: "2026-10-18" },
        previous: { fromDay: "2026-09-21", toDay: "2026-10-04" },
      },
      // Sunday 23:30 verified, undone by the user in the next hour: Monday, the next week
      index: InsightsProvider.indexReadings(
        readingsOf({
          "2026-10-11": {
            changeRequests: [
              {
                chatbotId: "1",
                action: Action.Verified,
                toolName: "update_record",
                isByChatbotUser: false,
                count: 10,
              },
            ],
          },
          "2026-10-12": {
            changeRequests: [
              {
                chatbotId: "1",
                action: Action.Undone,
                toolName: "update_record",
                isByChatbotUser: true,
                count: 5,
              },
            ],
          },
        }),
      ),
      roiAssumptions: [
        {
          taskType: "tool:update_record",
          manualMinutes: "6.0",
          effectiveFrom: "2026-10-01",
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
      ],
      writeTools: [{ name: "update_record", description: "Update a record" }],
      now: Date.parse("2026-10-20T12:00:00Z"),
    });

    expect(impact.hoursSaved.value).toBe(0.5);
    expect(impact.hoursPerWeek).toEqual([
      { weekStartDay: "2026-10-05", hours: 0.5 },
      { weekStartDay: "2026-10-12", hours: 0 },
    ]);
  });
});
