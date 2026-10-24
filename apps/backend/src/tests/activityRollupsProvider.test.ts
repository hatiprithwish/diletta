import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ActivityRollupsProvider from "@/providers/activityRollups";

// DEV_NOTE: Unit tests for the rollup metric set (M4-2): no database

const Measure = Schemas.ActivityRollupModelCallMeasureEnum;
const { Live, Eval } = Schemas.ActivityRollupModelCallScopeEnum;
const empty = { conversations: [], feedback: [], changeRequests: [], modelCalls: [] };
const modelCall = (
  overrides: Partial<Schemas.ModelCallRollupGroup> = {},
): Schemas.ModelCallRollupGroup => ({
  chatbotId: "1",
  isEval: false,
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

  it("adds every chatbot's group to the company-wide row, and background calls only there", () => {
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      modelCalls: [
        modelCall({ chatbotId: "1", costUsd: "0.100000" }),
        modelCall({ chatbotId: "2", costUsd: "0.200000" }),
        modelCall({
          chatbotId: null,
          taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
          costUsd: "0.000001",
        }),
      ],
    });
    const cost = (chatbotId: string | null, metric: string) =>
      values.find((value) => value.chatbotId === chatbotId && value.metric === metric)?.value;
    const byModel = Schemas.modelCallModelRollupMetric(
      Live,
      Measure.CostUsd,
      Schemas.ModelProviderEnum.Anthropic,
      "claude-sonnet-5-5",
    );
    const byBackgroundTask = Schemas.modelCallTaskRollupMetric(
      Live,
      Measure.CostUsd,
      Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
    );

    expect(cost("1", byModel)).toBe("0.100000");
    expect(cost("2", byModel)).toBe("0.200000");
    expect(cost(null, byModel)).toBe("0.300001");
    expect(cost(null, byBackgroundTask)).toBe("0.000001");
    expect(
      values
        .filter((value) => value.metric.includes("knowledge.embed"))
        .every((value) => value.chatbotId === null),
    ).toBe(true);
  });

  it("keeps eval calls under their own keys, even when they carry the chatbot under test", () => {
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      modelCalls: [
        modelCall({ chatbotId: "1", costUsd: "0.100000" }),
        modelCall({ chatbotId: "1", isEval: true, costUsd: "0.050000" }),
        modelCall({
          chatbotId: null,
          isEval: true,
          taskType: Schemas.ModelTaskTypeEnum.EvalJudge,
          costUsd: "0.010000",
        }),
      ],
    });
    const cost = (chatbotId: string | null, metric: string) =>
      values.find((value) => value.chatbotId === chatbotId && value.metric === metric)?.value;
    const qa = Schemas.ModelTaskTypeEnum.QaAnswer;
    const judge = Schemas.ModelTaskTypeEnum.EvalJudge;

    expect(cost("1", Schemas.modelCallTaskRollupMetric(Live, Measure.CostUsd, qa))).toBe(
      "0.100000",
    );
    expect(cost(null, Schemas.modelCallTaskRollupMetric(Live, Measure.CostUsd, qa))).toBe(
      "0.100000",
    );
    expect(cost("1", Schemas.modelCallTaskRollupMetric(Eval, Measure.CostUsd, qa))).toBe(
      "0.050000",
    );
    expect(cost(null, Schemas.modelCallTaskRollupMetric(Eval, Measure.CostUsd, judge))).toBe(
      "0.010000",
    );
    expect(Schemas.modelCallTaskRollupMetric(Eval, Measure.CostUsd, judge)).toBe(
      "model_calls.eval.cost_usd.task.eval.judge",
    );
    expect(
      cost(null, Schemas.modelCallTaskRollupMetric(Live, Measure.CostUsd, judge)),
    ).toBeUndefined();
  });

  it("sums costs exactly, where floats would drift", () => {
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      modelCalls: Array.from({ length: 10 }, () => modelCall({ costUsd: "0.100000" })),
    });
    const metric = Schemas.modelCallTaskRollupMetric(
      Live,
      Measure.CostUsd,
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
          isByChatbotUser: false,
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

  it("counts the user's undos of verified changes apart from auto-undos", () => {
    const undone = (isByChatbotUser: boolean, count: number): Schemas.ChangeRequestRollupGroup => ({
      chatbotId: "1",
      action: Schemas.ChangeRequestEntityActionEnum.Undone,
      toolName: "update_record",
      isByChatbotUser,
      count,
    });
    const values = ActivityRollupsProvider.buildValues({
      ...empty,
      changeRequests: [undone(true, 2), undone(false, 3)],
    });
    expect(values.filter((value) => value.chatbotId === "1")).toEqual([
      { chatbotId: "1", metric: "change_requests.undone.tool.update_record", value: "5" },
      { chatbotId: "1", metric: "change_requests.user_undone.tool.update_record", value: "2" },
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
