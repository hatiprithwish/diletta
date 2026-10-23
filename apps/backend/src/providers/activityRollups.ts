import * as Schemas from "@app/schemas";

// DEV_NOTE: Fixed-point scale of each kind of value: counts and tokens are whole numbers, costs keep the 6 decimals of
// model_calls.cost_usd. Values are summed as bigint in these units, so a total is exact however many rows it adds.
const COUNT_SCALE = 0;
const COST_SCALE = 6;

type RollupSources = {
  conversations: Schemas.ConversationRollupGroup[];
  feedback: Schemas.FeedbackRollupGroup[];
  changeRequests: Schemas.ChangeRequestRollupGroup[];
  modelCalls: Schemas.ModelCallRollupGroup[];
};

type Total = { chatbotId: string | null; metric: string; units: bigint; scale: number };

// DEV_NOTE: Turns one day's source groups into activity_rollups values (M4-2). Pure, so the metric set is unit-tested
// without a database. Every group adds to its chatbot's row (if it has one) and to the company-wide row (chatbotId
// null), so the company-wide row also holds background jobs (no chatbot). Eval calls go under the Eval scope's keys
// (model_calls.eval.*), never the live ones, so a chatbot's live usage leaves out its test runs. Output is sorted
// (company-wide first, then by chatbot and metric), so a rebuild of unchanged data writes the same rows.
export default class ActivityRollupsProvider {
  static buildValues(sources: RollupSources): Schemas.ActivityRollupValue[] {
    const totals = new Map<string, Total>();
    const add = (
      chatbotId: string | null,
      metric: string,
      value: string | number,
      scale: number,
    ) => {
      const units = ActivityRollupsProvider.toUnits(value, scale);
      for (const owner of chatbotId === null ? [null] : [chatbotId, null]) {
        const key = `${owner ?? ""}\u0000${metric}`;
        const total = totals.get(key);
        if (total) {
          total.units += units;
        } else {
          totals.set(key, { chatbotId: owner, metric, units, scale });
        }
      }
    };

    for (const group of sources.conversations) {
      add(group.chatbotId, Schemas.ACTIVITY_ROLLUP_CONVERSATIONS_STARTED, group.count, COUNT_SCALE);
      if (group.outcome !== null) {
        add(
          group.chatbotId,
          Schemas.conversationOutcomeMetric(group.outcome),
          group.count,
          COUNT_SCALE,
        );
      }
    }

    for (const group of sources.feedback) {
      add(
        group.chatbotId,
        Schemas.ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[group.rating],
        group.count,
        COUNT_SCALE,
      );
    }

    for (const group of sources.changeRequests) {
      add(
        group.chatbotId,
        Schemas.changeRequestRollupMetric(group.action, group.toolName),
        group.count,
        COUNT_SCALE,
      );
      // DEV_NOTE: The user's own undo of a verified change, apart from auto-undos (never verified)
      if (group.action === Schemas.ChangeRequestEntityActionEnum.Undone && group.isByChatbotUser) {
        add(
          group.chatbotId,
          Schemas.changeRequestUserUndoRollupMetric(group.toolName),
          group.count,
          COUNT_SCALE,
        );
      }
    }

    const Measure = Schemas.ActivityRollupModelCallMeasureEnum;
    for (const group of sources.modelCalls) {
      const scope = group.isEval
        ? Schemas.ActivityRollupModelCallScopeEnum.Eval
        : Schemas.ActivityRollupModelCallScopeEnum.Live;
      const measures: [Schemas.ActivityRollupModelCallMeasureEnum, string | number, number][] = [
        [Measure.Count, group.count, COUNT_SCALE],
        [Measure.InputTokens, group.inputTokens, COUNT_SCALE],
        [Measure.OutputTokens, group.outputTokens, COUNT_SCALE],
        [Measure.CostUsd, group.costUsd, COST_SCALE],
      ];
      for (const [measure, value, scale] of measures) {
        add(
          group.chatbotId,
          Schemas.modelCallTaskRollupMetric(scope, measure, group.taskType),
          value,
          scale,
        );
        add(
          group.chatbotId,
          Schemas.modelCallModelRollupMetric(scope, measure, group.provider, group.model),
          value,
          scale,
        );
      }
    }

    return [...totals.values()]
      .sort(
        (a, b) =>
          ActivityRollupsProvider.compare(a.chatbotId ?? "", b.chatbotId ?? "") ||
          ActivityRollupsProvider.compare(a.metric, b.metric),
      )
      .map((total) => ({
        chatbotId: total.chatbotId,
        metric: total.metric,
        value: ActivityRollupsProvider.fromUnits(total.units, total.scale),
      }));
  }

  // DEV_NOTE: A non-negative decimal (a count, or a sum the database cast to text) as bigint units of 10^-scale.
  // Digits past the scale can't occur (cost_usd is numeric(12, 6)) and are dropped.
  static toUnits(value: string | number, scale: number): bigint {
    const text = typeof value === "number" ? String(value) : value.trim();
    const [whole = "0", fraction = ""] = text.split(".");
    return BigInt(`${whole || "0"}${fraction.padEnd(scale, "0").slice(0, scale)}`);
  }

  static fromUnits(units: bigint, scale: number): string {
    if (scale === 0) return units.toString();
    const digits = units.toString().padStart(scale + 1, "0");
    return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }

  // DEV_NOTE: Plain code-unit order, not locale order, so the result never depends on the runtime's locale data
  private static compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}
