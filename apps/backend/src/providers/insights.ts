import ActivityRollupsProvider from "@/providers/activityRollups";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Fixed-point scale of a cost (model_calls.cost_usd keeps 6 decimals). Costs are summed as bigint micros, so
// a page's total equals the raw SUM(cost_usd) exactly; counts and tokens are whole numbers.
const COST_SCALE = 6;
const MINUTES_PER_HOUR = 60;

type Reading = {
  day: Schemas.ActivityRollupDay;
  metric: Schemas.ParsedActivityRollupMetric;
  value: string;
};

type MonthWindow = { fromDay: Schemas.ActivityRollupDay; toDay: Schemas.ActivityRollupDay };

const Kind = Schemas.ActivityRollupMetricKindEnum;
const Measure = Schemas.ActivityRollupModelCallMeasureEnum;
const Scope = Schemas.ActivityRollupModelCallScopeEnum;

// DEV_NOTE: The Insights pages' numbers (M4-3), from one owner's activity_rollups readings (a chatbot's or the company
// row). Pure, so every rule is unit-tested without a database:
//   - spend = cost of the model keys whose provider the company pays (its own key); platform-paid calls (Workers AI
//     embeddings and rerank) are shown as Included and left out, like the budget leaves them out. Live + eval.
//   - a model call's use comes from its task type; a platform task (search) is Search in either scope, any other eval
//     call is a test run, so the non-included rows of By use add up to the spend.
//   - an Impact task's count is its net work: a tool's verified minus undone changes, or the conversations answered;
//     its time = Σ per day of count × the minutes in force that day (roiMinutesOnDay). Never below 0.
export default class InsightsProvider {
  static parseReadings(readings: Schemas.ActivityRollupReading[]): Reading[] {
    const parsed: Reading[] = [];
    for (const reading of readings) {
      const metric = Schemas.parseActivityRollupMetric(reading.metric);
      if (metric) parsed.push({ day: reading.day, metric, value: reading.value });
    }
    return parsed;
  }

  static buildOverview(params: {
    periods: Schemas.InsightsPeriods;
    readings: Reading[];
    month: MonthWindow & { resetsOnDay: Schemas.ActivityRollupDay };
    budgetUsd: string;
    attention: Schemas.InsightsOverviewAttention;
    liveConfig: Schemas.InsightsLiveConfig | null;
  }): Schemas.InsightsOverview {
    const { periods, readings, month } = params;
    const { current, previous } = periods;
    const Outcome = Schemas.ConversationOutcomeIntEnum;

    const started = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.sumCount(readings, period, (m) => m.kind === Kind.ConversationsStarted);
    const outcomes = (
      period: Schemas.InsightsPeriod,
      wanted: Schemas.ConversationOutcomeIntEnum[],
    ) =>
      InsightsProvider.sumCount(
        readings,
        period,
        (m) => m.kind === Kind.ConversationOutcome && wanted.includes(m.outcome),
      );
    const answeredRate = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.rate(
        outcomes(period, [Outcome.Answered, Outcome.ActionDone]),
        outcomes(period, [Outcome.Answered, Outcome.ActionDone, Outcome.Idk, Outcome.Handoff]),
      );
    const rated = (rating: Schemas.FeedbackRatingIntEnum) =>
      InsightsProvider.sumCount(
        readings,
        current,
        (m) => m.kind === Kind.Feedback && m.rating === rating,
      );
    const changeEvents = (action: Schemas.ActivityRollupChangeRequestAction) =>
      InsightsProvider.sumCount(
        readings,
        current,
        (m) => m.kind === Kind.ChangeRequest && m.action === action,
      );

    const up = rated(Schemas.FeedbackRatingIntEnum.Up);
    const ratedCount = up + rated(Schemas.FeedbackRatingIntEnum.Down);
    const Action = Schemas.ChangeRequestEntityActionEnum;

    return {
      current,
      previous,
      conversations: { value: started(current), previousValue: started(previous) },
      answeredRate: { value: answeredRate(current), previousValue: answeredRate(previous) },
      helpfulRate: { value: InsightsProvider.rate(up, ratedCount), ratedCount },
      changes: {
        verified: changeEvents(Action.Verified),
        undone: changeEvents(Action.Undone),
        needsHuman: changeEvents(Action.NeedsHuman),
      },
      conversationsPerDay: InsightsProvider.days(current).map((day) => ({
        day,
        value: InsightsProvider.sumCount(
          readings,
          { fromDay: day, toDay: day },
          (m) => m.kind === Kind.ConversationsStarted,
        ),
      })),
      monthSpend: {
        fromDay: month.fromDay,
        resetsOnDay: month.resetsOnDay,
        spentUsd: InsightsProvider.spendUsd(readings, month),
        testRunsUsd: InsightsProvider.spendUsd(readings, month, Scope.Eval),
        budgetUsd: params.budgetUsd,
      },
      attention: params.attention,
      liveConfig: params.liveConfig,
    };
  }

  static buildUsage(params: {
    periods: Schemas.InsightsPeriods;
    readings: Reading[];
  }): Schemas.InsightsUsage {
    const { readings } = params;
    const { current, previous } = params.periods;

    const calls = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.sumCount(
        readings,
        period,
        (m) => m.kind === Kind.ModelCallModel && m.measure === Measure.Count,
      );
    const costPerConversation = (period: Schemas.InsightsPeriod) => {
      const conversations = InsightsProvider.sumCount(
        readings,
        period,
        (m) => m.kind === Kind.ConversationsStarted,
      );
      if (conversations === 0) return null;
      const live = InsightsProvider.spendUnits(readings, period, Scope.Live);
      // DEV_NOTE: Rounded half up to the micro-dollar
      const units = (live * 2n + BigInt(conversations)) / (BigInt(conversations) * 2n);
      return ActivityRollupsProvider.fromUnits(units, COST_SCALE);
    };

    return {
      current,
      previous,
      spend: {
        valueUsd: InsightsProvider.spendUsd(readings, current),
        previousValueUsd: InsightsProvider.spendUsd(readings, previous),
        testRunsUsd: InsightsProvider.spendUsd(readings, current, Scope.Eval),
      },
      modelCalls: { value: calls(current), previousValue: calls(previous) },
      costPerConversation: {
        valueUsd: costPerConversation(current),
        previousValueUsd: costPerConversation(previous),
      },
      spendPerDay: InsightsProvider.days(current).map((day) => ({
        day,
        costUsd: InsightsProvider.spendUsd(readings, { fromDay: day, toDay: day }),
      })),
      byUse: InsightsProvider.byUse(readings, current),
      byModel: InsightsProvider.byModel(readings, current),
    };
  }

  static buildImpact(params: {
    periods: Schemas.InsightsPeriods;
    readings: Reading[];
    roiAssumptions: Pick<
      Schemas.RoiAssumption,
      "taskType" | "manualMinutes" | "effectiveFrom" | "createdAt"
    >[];
    writeTools: Pick<Schemas.ToolDefinition, "name" | "description">[];
    now: number;
  }): Schemas.InsightsImpact {
    const { readings, periods, now } = params;
    const { current, previous } = periods;
    const today = Schemas.activityRollupDayKey(now);

    // Every task: answers, every write tool, and any tool whose changes show in the readings (renamed or retired since)
    const descriptions = new Map(params.writeTools.map((tool) => [tool.name, tool.description]));
    const toolNames = new Set(descriptions.keys());
    for (const reading of readings) {
      if (reading.metric.kind === Kind.ChangeRequest) toolNames.add(reading.metric.toolName);
    }
    const tasks: { taskType: string; toolName: string | null }[] = [
      { taskType: Schemas.ROI_ANSWERS_TASK_TYPE, toolName: null },
      ...[...toolNames]
        .sort()
        .map((name) => ({ taskType: Schemas.roiToolTaskType(name), toolName: name })),
    ];

    // Net count per (task, day)
    const net = new Map<string, Map<Schemas.ActivityRollupDay, number>>();
    const addNet = (taskType: string, day: Schemas.ActivityRollupDay, count: number) => {
      const byDay = net.get(taskType) ?? new Map<Schemas.ActivityRollupDay, number>();
      byDay.set(day, (byDay.get(day) ?? 0) + count);
      net.set(taskType, byDay);
    };
    for (const { day, metric, value } of readings) {
      if (
        metric.kind === Kind.ConversationOutcome &&
        metric.outcome === Schemas.ConversationOutcomeIntEnum.Answered
      ) {
        addNet(Schemas.ROI_ANSWERS_TASK_TYPE, day, Number(value));
      }
      if (metric.kind === Kind.ChangeRequest) {
        const sign =
          metric.action === Schemas.ChangeRequestEntityActionEnum.Verified
            ? 1
            : metric.action === Schemas.ChangeRequestEntityActionEnum.Undone
              ? -1
              : 0;
        addNet(Schemas.roiToolTaskType(metric.toolName), day, sign * Number(value));
      }
    }

    const rowsByTask = new Map<string, typeof params.roiAssumptions>();
    for (const row of params.roiAssumptions) {
      rowsByTask.set(row.taskType, [...(rowsByTask.get(row.taskType) ?? []), row]);
    }
    // Hours a task saved on the days of a period, before the floor at 0
    const rawHours = (taskType: string, period: Schemas.InsightsPeriod) => {
      const rows = rowsByTask.get(taskType) ?? [];
      let hours = 0;
      for (const [day, count] of net.get(taskType) ?? []) {
        if (day < period.fromDay || day > period.toDay) continue;
        const minutes = Schemas.roiMinutesOnDay(rows, day);
        if (minutes !== null) hours += (count * Number(minutes)) / MINUTES_PER_HOUR;
      }
      return hours;
    };
    const netCount = (taskType: string, period: Schemas.InsightsPeriod) => {
      let total = 0;
      for (const [day, count] of net.get(taskType) ?? []) {
        if (day >= period.fromDay && day <= period.toDay) total += count;
      }
      return Math.max(0, total);
    };

    const impactTasks: Schemas.InsightsImpactTask[] = tasks
      .map(({ taskType, toolName }) => ({
        taskType,
        kind:
          toolName === null ? Schemas.ImpactTaskKindEnum.Answers : Schemas.ImpactTaskKindEnum.Tool,
        toolName,
        label:
          toolName === null
            ? Schemas.ROI_ANSWERS_TASK_LABEL
            : (descriptions.get(toolName) ?? toolName),
        count: netCount(taskType, current),
        manualMinutes: Schemas.roiMinutesOnDay(rowsByTask.get(taskType) ?? [], today),
        hoursSaved: InsightsProvider.roundHours(Math.max(0, rawHours(taskType, current))),
      }))
      .sort((a, b) => b.hoursSaved - a.hoursSaved || b.count - a.count);

    const totalHours = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.roundHours(
        tasks.reduce((total, task) => total + Math.max(0, rawHours(task.taskType, period)), 0),
      );
    const hoursSaved = totalHours(current);
    const workingDays = Schemas.insightsWorkingDays(current, now);

    const weekStarts = [...new Set(InsightsProvider.days(current).map(Schemas.insightsWeekStart))];
    const hoursPerWeek = weekStarts.map((weekStartDay) => {
      const weekEnd = Schemas.activityRollupAddDays(weekStartDay, 6);
      // DEV_NOTE: The week cut to the range, so a week the range starts or ends in counts only its days in range
      const week = {
        fromDay: weekStartDay < current.fromDay ? current.fromDay : weekStartDay,
        toDay: weekEnd > current.toDay ? current.toDay : weekEnd,
      };
      return { weekStartDay, hours: totalHours(week) };
    });

    return {
      current,
      previous,
      hoursSaved: { value: hoursSaved, previousValue: totalHours(previous) },
      tasksDone: impactTasks.reduce((total, task) => total + task.count, 0),
      workingDays,
      hoursPerWorkingDay:
        workingDays === 0 ? null : InsightsProvider.roundHours(hoursSaved / workingDays),
      hoursPerWeek,
      tasks: impactTasks,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private static inPeriod(day: Schemas.ActivityRollupDay, period: Schemas.InsightsPeriod) {
    return day >= period.fromDay && day <= period.toDay;
  }

  private static days(period: Schemas.InsightsPeriod): Schemas.ActivityRollupDay[] {
    return Schemas.activityRollupDays(period.fromDay, period.toDay);
  }

  private static sumCount(
    readings: Reading[],
    period: Schemas.InsightsPeriod,
    match: (metric: Schemas.ParsedActivityRollupMetric) => boolean,
  ): number {
    let total = 0;
    for (const reading of readings) {
      if (InsightsProvider.inPeriod(reading.day, period) && match(reading.metric)) {
        total += Number(reading.value);
      }
    }
    return total;
  }

  // Cost the company pays (its own key), in micros; scope = one scope only, else live + eval
  private static spendUnits(
    readings: Reading[],
    period: Schemas.InsightsPeriod,
    scope?: Schemas.ActivityRollupModelCallScopeEnum,
  ): bigint {
    let units = 0n;
    for (const { day, metric, value } of readings) {
      if (
        metric.kind === Kind.ModelCallModel &&
        metric.measure === Measure.CostUsd &&
        !Schemas.isPlatformPaidProvider(metric.provider) &&
        (scope === undefined || metric.scope === scope) &&
        InsightsProvider.inPeriod(day, period)
      ) {
        units += ActivityRollupsProvider.toUnits(value, COST_SCALE);
      }
    }
    return units;
  }

  private static spendUsd(
    readings: Reading[],
    period: Schemas.InsightsPeriod,
    scope?: Schemas.ActivityRollupModelCallScopeEnum,
  ): string {
    return ActivityRollupsProvider.fromUnits(
      InsightsProvider.spendUnits(readings, period, scope),
      COST_SCALE,
    );
  }

  private static useOf(
    scope: Schemas.ActivityRollupModelCallScopeEnum,
    taskType: string,
  ): Schemas.InsightsUsageUseEnum | null {
    const use = Schemas.INSIGHTS_TASK_TYPE_USE_MAP[taskType as Schemas.ModelTaskTypeEnum] ?? null;
    if (use === Schemas.InsightsUsageUseEnum.Search) return use;
    if (scope === Scope.Eval) return Schemas.InsightsUsageUseEnum.TestRuns;
    return use;
  }

  private static byUse(
    readings: Reading[],
    period: Schemas.InsightsPeriod,
  ): Schemas.InsightsUsageRow[] {
    const totals = new Map<
      Schemas.InsightsUsageUseEnum,
      { calls: number; tokens: number; units: bigint }
    >();
    for (const { day, metric, value } of readings) {
      if (metric.kind !== Kind.ModelCallTask || !InsightsProvider.inPeriod(day, period)) continue;
      const use = InsightsProvider.useOf(metric.scope, metric.taskType);
      if (use === null) continue;
      const total = totals.get(use) ?? { calls: 0, tokens: 0, units: 0n };
      if (metric.measure === Measure.Count) total.calls += Number(value);
      if (metric.measure === Measure.InputTokens || metric.measure === Measure.OutputTokens) {
        total.tokens += Number(value);
      }
      if (metric.measure === Measure.CostUsd) {
        total.units += ActivityRollupsProvider.toUnits(value, COST_SCALE);
      }
      totals.set(use, total);
    }

    return Object.values(Schemas.InsightsUsageUseEnum)
      .filter((use) => (totals.get(use)?.calls ?? 0) > 0)
      .map((use) => {
        const total = totals.get(use)!;
        return {
          use,
          useLabel: Schemas.INSIGHTS_USAGE_USE_LABEL_MAP[use],
          calls: total.calls,
          tokens: total.tokens,
          costUsd: ActivityRollupsProvider.fromUnits(total.units, COST_SCALE),
          isIncluded: use === Schemas.InsightsUsageUseEnum.Search,
        };
      });
  }

  private static byModel(
    readings: Reading[],
    period: Schemas.InsightsPeriod,
  ): Schemas.InsightsModelRow[] {
    const totals = new Map<
      string,
      { provider: string; model: string; calls: number; units: bigint }
    >();
    for (const { day, metric, value } of readings) {
      if (metric.kind !== Kind.ModelCallModel || !InsightsProvider.inPeriod(day, period)) continue;
      const key = `${metric.provider}/${metric.model}`;
      const total = totals.get(key) ?? {
        provider: metric.provider,
        model: metric.model,
        calls: 0,
        units: 0n,
      };
      if (metric.measure === Measure.Count) total.calls += Number(value);
      if (metric.measure === Measure.CostUsd) {
        total.units += ActivityRollupsProvider.toUnits(value, COST_SCALE);
      }
      totals.set(key, total);
    }

    return [...totals.values()]
      .filter((total) => total.calls > 0)
      .sort((a, b) =>
        a.units === b.units
          ? b.calls - a.calls || a.model.localeCompare(b.model)
          : a.units > b.units
            ? -1
            : 1,
      )
      .map((total) => ({
        provider: total.provider,
        providerLabel:
          Schemas.INSIGHTS_PROVIDER_LABEL_MAP[
            total.provider as keyof typeof Schemas.INSIGHTS_PROVIDER_LABEL_MAP
          ] ?? total.provider,
        model: total.model,
        calls: total.calls,
        costUsd: ActivityRollupsProvider.fromUnits(total.units, COST_SCALE),
        isIncluded: Schemas.isPlatformPaidProvider(total.provider),
      }));
  }

  private static rate(part: number, whole: number): number | null {
    return whole === 0 ? null : part / whole;
  }

  // DEV_NOTE: Hours to the hundredth, so float noise from minutes × counts never shows
  private static roundHours(hours: number): number {
    return Math.round(hours * 100) / 100;
  }
}
