import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ActivityRollupsProvider from "@/providers/activityRollups";

// DEV_NOTE: Unit tests for the rollup metric set (M4-2): no database

const empty = { conversations: [], feedback: [], changeRequests: [], modelCalls: [] };
const modelCall = (
  overrides: Partial<Schemas.ModelCallRollupGroup> = {},
): Schemas.ModelCallRollupGroup => ({
  chatbotId: "1",
  taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
  provider: Schemas.ModelProviderEnum.Anthropic,
  model: "claude-sonnet-5-5",
  count: 1,
  inputTokens: "0",
  outputTokens: "0",
  costUsd: "0.000000",
  ...overrides,
});

describe("ActivityRollupsProvider.buildValues", () => {
  it("writes nothing for a day with no activity", () => {
    expect(ActivityRollupsProvider.buildValues(empty)).toEqual([]);
  });

  it("adds every chatbot's group to the company-wide row, and calls with no chatbot only there", () => {
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      modelCalls: [
        modelCall({ chatbotId: "1", costUsd: "0.100000" }),
        modelCall({ chatbotId: "2", costUsd: "0.200000" }),
        modelCall({
          chatbotId: null,
          taskType: Schemas.ModelTaskTypeEnum.EvalJudge,
          costUsd: "0.000001",
        }),
      ],
    });
    const cost = (chatbotId: string | null, metric: string) =>
      values.find((value) => value.chatbotId === chatbotId && value.metric === metric)?.value;
    const Measure = Schemas.ActivityRollupModelCallMeasureEnum;
    const byModel = Schemas.modelCallModelRollupMetric(
      Measure.CostUsd,
      Schemas.ModelProviderEnum.Anthropic,
      "claude-sonnet-5-5",
    );

    expect(cost("1", byModel)).toBe("0.100000");
    expect(cost("2", byModel)).toBe("0.200000");
    expect(cost(null, byModel)).toBe("0.300001");
    expect(
      cost(
        null,
        Schemas.modelCallTaskRollupMetric(Measure.CostUsd, Schemas.ModelTaskTypeEnum.EvalJudge),
      ),
    ).toBe("0.000001");
    expect(
      values.some((value) => value.chatbotId === null && value.metric.includes("eval.judge")),
    ).toBe(true);
    expect(
      values
        .filter((value) => value.metric.includes("eval.judge"))
        .every((value) => value.chatbotId === null),
    ).toBe(true);
  });

  it("sums costs exactly, where floats would drift", () => {
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      modelCalls: Array.from({ length: 10 }, () => modelCall({ costUsd: "0.100000" })),
    });
    const metric = Schemas.modelCallTaskRollupMetric(
      Schemas.ActivityRollupModelCallMeasureEnum.CostUsd,
      Schemas.ModelTaskTypeEnum.QaAnswer,
    );
    expect(values.find((value) => value.chatbotId === null && value.metric === metric)?.value).toBe(
      "1.000000",
    );
  });

  it("counts conversations by start, outcomes only once closed, ratings and change request events by tool", () => {
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      conversations: [
        { chatbotId: "1", outcome: null, count: 2 },
        { chatbotId: "1", outcome: Schemas.ConversationOutcomeIntEnum.Idk, count: 3 },
      ],
      feedback: [{ chatbotId: "1", rating: Schemas.FeedbackRatingIntEnum.Down, count: 4 }],
      changeRequests: [
        {
          chatbotId: "1",
          action: Schemas.ChangeRequestEntityActionEnum.NeedsHuman,
          toolName: "update_record",
          count: 1,
        },
      ],
    });
    expect(values.filter((value) => value.chatbotId === "1")).toEqual([
      { chatbotId: "1", metric: "change_requests.needs_human.tool.update_record", value: "1" },
      { chatbotId: "1", metric: "conversations.outcome.idk", value: "3" },
      { chatbotId: "1", metric: "conversations.started", value: "5" },
      { chatbotId: "1", metric: "feedback.down", value: "4" },
    ]);
  });

  it("orders the values the same way whatever order the groups came in", () => {
    const groups = [
      modelCall({ chatbotId: "2" }),
      modelCall({ chatbotId: "1", model: "b" }),
      modelCall({ chatbotId: "1", model: "a" }),
    ];
    const forward = ActivityRollupsProvider.buildValues({ ...empty, modelCalls: groups });
    const reversed = ActivityRollupsProvider.buildValues({
      ...empty,
      modelCalls: [...groups].reverse(),
    });
    expect(reversed).toEqual(forward);
    expect(forward[0]?.chatbotId).toBeNull();
  });
});

describe("ActivityRollupsProvider units", () => {
  it("reads and writes decimals in fixed-point units", () => {
    expect(ActivityRollupsProvider.toUnits("12.345678", 6)).toBe(12345678n);
    expect(ActivityRollupsProvider.toUnits("0.5", 6)).toBe(500000n);
    expect(ActivityRollupsProvider.toUnits("7", 6)).toBe(7000000n);
    expect(ActivityRollupsProvider.toUnits(42, 0)).toBe(42n);
    expect(ActivityRollupsProvider.fromUnits(12345678n, 6)).toBe("12.345678");
    expect(ActivityRollupsProvider.fromUnits(1n, 6)).toBe("0.000001");
    expect(ActivityRollupsProvider.fromUnits(0n, 6)).toBe("0.000000");
    expect(ActivityRollupsProvider.fromUnits(9007199254740993n, 0)).toBe("9007199254740993");
  });
});
