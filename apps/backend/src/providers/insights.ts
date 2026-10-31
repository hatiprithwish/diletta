import * as Schemas from "@app/schemas";
import Utility from "@/utils/Utility";

// DEV_NOTE: Fixed-point scale of a cost (model_calls.cost_usd keeps 6 decimals). Costs are summed as bigint micros, so
// a page's total equals the raw SUM(cost_usd) exactly; counts and tokens are whole numbers.
const COST_SCALE = 6;
const MINUTES_PER_HOUR = 60;

type UseTotal = { calls: number; tokens: number; units: bigint };
type ModelTotal = { provider: string; model: string; calls: number; units: bigint };

// DEV_NOTE: One day's readings, added up once by what the pages ask of them
type DayTotals = {
  started: number;
  outcomes: Map<Schemas.ConversationOutcomeIntEnum, number>;
  ratings: Map<Schemas.FeedbackRatingIntEnum, number>;
  changeEvents: Map<Schemas.ActivityRollupChangeRequestAction, number>;
  // Cost the company pays on its own key (platform-paid providers left out), by scope
  paidLiveUnits: bigint;
  paidEvalUnits: bigint;
  calls: number;
  uses: Map<Schemas.InsightsUsageUseEnum, UseTotal>;
  models: Map<string, ModelTotal>;
  // Impact's net work per task type: answers, or a tool's verified − its user's undos
  taskNet: Map<string, number>;
};

type DayIndex = Map<Schemas.ActivityRollupDay, DayTotals>;

type MonthWindow = { fromDay: Schemas.ActivityRollupDay; toDay: Schemas.ActivityRollupDay };

const Kind = Schemas.ActivityRollupMetricKindEnum;
const Measure = Schemas.ActivityRollupModelCallMeasureEnum;
const Scope = Schemas.ActivityRollupModelCallScopeEnum;

// DEV_NOTE: The Insights pages' numbers (M4-3), from one owner's activity_rollups readings (a chatbot's or the company
// row). Pure, so every rule is unit-tested without a database. The readings are indexed by day once (indexReadings),
// then every total and day series is a sum over the days of its period, so a request stays linear in its readings.
//   - spend = cost of the model keys whose provider the company pays (its own key); platform-paid calls (Workers AI
//     embeddings and rerank) are shown as Included and left out, like the budget leaves them out. Live + eval.
//   - a model call's use comes from its task type; a platform task (search) is Search in either scope, any other eval
//     call is a test run, so the non-included rows of By use add up to the spend.
//   - an Impact task's count is its net work: a tool's verified changes minus the ones its users undid (never the
//     auto-undos, which were never verified), or the conversations answered; its time = Σ per day of count × the
//     minutes in force that day (roiMinutesOnDay). A task never goes below 0 over the range, and the weekly bars add up
//     to the range's total (spreadWeeks).
export default class InsightsProvider {
  static indexReadings(readings: Schemas.ActivityRollupReading[]): DayIndex {
    const index: DayIndex = new Map();
    for (const reading of readings) {
      const metric = Schemas.parseActivityRollupMetric(reading.metric);
      if (!metric) continue;
      const day = index.get(reading.day) ?? InsightsProvider.emptyDay();
      index.set(reading.day, day);
      InsightsProvider.addReading(day, metric, reading.value);
    }
    return index;
  }

  static buildOverview(params: {
    periods: Schemas.InsightsPeriods;
    index: DayIndex;
    // DEV_NOTE: The company-wide rows for the billing month: the budget is the company's, whatever bot the page shows
    monthIndex: DayIndex;
    month: MonthWindow & { resetsOnDay: Schemas.ActivityRollupDay };
    budgetUsd: string;
    attention: Schemas.InsightsOverviewAttention;
    liveConfig: Schemas.InsightsLiveConfig | null;
  }): Schemas.InsightsOverview {
    const { periods, index, month } = params;
    const { current, previous } = periods;
    const Outcome = Schemas.ConversationOutcomeIntEnum;
    const Action = Schemas.ChangeRequestEntityActionEnum;

    const outcomes = (
      period: Schemas.InsightsPeriod,
      wanted: Schemas.ConversationOutcomeIntEnum[],
    ) =>
      InsightsProvider.sum(index, period, (day) =>
        wanted.reduce((total, outcome) => total + (day.outcomes.get(outcome) ?? 0), 0),
      );
    const answeredRate = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.rate(
        outcomes(period, [Outcome.Answered, Outcome.ActionDone]),
        outcomes(period, [Outcome.Answered, Outcome.ActionDone, Outcome.Idk, Outcome.Handoff]),
      );
    const rated = (rating: Schemas.FeedbackRatingIntEnum) =>
      InsightsProvider.sum(index, current, (day) => day.ratings.get(rating) ?? 0);
    const changeEvents = (action: Schemas.ActivityRollupChangeRequestAction) =>
      InsightsProvider.sum(index, current, (day) => day.changeEvents.get(action) ?? 0);
    const started = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.sum(index, period, (day) => day.started);

    const up = rated(Schemas.FeedbackRatingIntEnum.Up);
    const ratedCount = up + rated(Schemas.FeedbackRatingIntEnum.Down);

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
        value: index.get(day)?.started ?? 0,
      })),
      monthSpend: {
        fromDay: month.fromDay,
        resetsOnDay: month.resetsOnDay,
        spentUsd: InsightsProvider.spendUsd(params.monthIndex, month),
        testRunsUsd: InsightsProvider.spendUsd(params.monthIndex, month, Scope.Eval),
        budgetUsd: params.budgetUsd,
      },
      attention: params.attention,
      liveConfig: params.liveConfig,
    };
  }

  static buildUsage(params: {
    periods: Schemas.InsightsPeriods;
    index: DayIndex;
  }): Schemas.InsightsUsage {
    const { index } = params;
    const { current, previous } = params.periods;

    const calls = (period: Schemas.InsightsPeriod) =>
      InsightsProvider.sum(index, period, (day) => day.calls);
    const costPerConversation = (period: Schemas.InsightsPeriod) => {
      const conversations = InsightsProvider.sum(index, period, (day) => day.started);
      if (conversations === 0) return null;
      const live = InsightsProvider.sumUnits(index, period, (day) => day.paidLiveUnits);
      // DEV_NOTE: Rounded half up to the micro-dollar
      const units = (live * 2n + BigInt(conversations)) / (BigInt(conversations) * 2n);
      return Utility.fromUnits(units, COST_SCALE);
    };

    return {
      current,
      previous,
      spend: {
        valueUsd: InsightsProvider.spendUsd(index, current),
        previousValueUsd: InsightsProvider.spendUsd(index, previous),
        testRunsUsd: InsightsProvider.spendUsd(index, current, Scope.Eval),
      },
      modelCalls: { value: calls(current), previousValue: calls(previous) },
      costPerConversation: {
        valueUsd: costPerConversation(current),
        previousValueUsd: costPerConversation(previous),
      },
      spendPerDay: InsightsProvider.days(current).map((day) => ({
        day,
        costUsd: InsightsProvider.spendUsd(index, { fromDay: day, toDay: day }),
      })),
      byUse: InsightsProvider.byUse(index, current),
      byModel: InsightsProvider.byModel(index, current),
    };
  }

  static buildImpact(params: {
    periods: Schemas.InsightsPeriods;
    index: DayIndex;
    roiAssumptions: Pick<
      Schemas.RoiAssumption,
      "taskType" | "manualMinutes" | "effectiveFrom" | "createdAt"
    >[];
    writeTools: Pick<Schemas.ToolDefinition, "name" | "description">[];
    now: number;
  }): Schemas.InsightsImpact {
    const { index, periods, now } = params;
    const { current, previous } = periods;
    const today = Schemas.activityRollupDayKey(now);

    // Every task: answers, every write tool, and any tool whose work shows in the readings (renamed or retired since)
    const descriptions = new Map(params.writeTools.map((tool) => [tool.name, tool.description]));
    const toolNames = new Set(descriptions.keys());
    for (const day of index.values()) {
      for (const taskType of day.taskNet.keys()) {
        const toolName = Schemas.roiTaskToolName(taskType);
        if (toolName !== null) toolNames.add(toolName);
      }
    }
    const tasks: { taskType: string; toolName: string | null }[] = [
      { taskType: Schemas.ROI_ANSWERS_TASK_TYPE, toolName: null },
      ...[...toolNames]
        .sort()
        .map((name) => ({ taskType: Schemas.roiToolTaskType(name), toolName: name })),
    ];

    const rowsByTask = new Map<string, typeof params.roiAssumptions>();
    for (const row of params.roiAssumptions) {
      rowsByTask.set(row.taskType, [...(rowsByTask.get(row.taskType) ?? []), row]);
    }
    // Hours a task saved on one day (negative when its users undid more than it did that day)
    const dayHours = (taskType: string, day: Schemas.ActivityRollupDay) => {
      const count = index.get(day)?.taskNet.get(taskType) ?? 0;
      if (count === 0) return 0;
      const minutes = Schemas.roiMinutesOnDay(rowsByTask.get(taskType) ?? [], day);
      return minutes === null ? 0 : (count * Number(minutes)) / MINUTES_PER_HOUR;
    };
    const taskHours = (taskType: string, period: Schemas.InsightsPeriod) =>
      Math.max(
        0,
        InsightsProvider.days(period).reduce((total, day) => total + dayHours(taskType, day), 0),
      );
    const netCount = (taskType: string, period: Schemas.InsightsPeriod) =>
      Math.max(
        0,
        InsightsProvider.sum(index, period, (day) => day.taskNet.get(taskType) ?? 0),
      );

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
        hoursSaved: InsightsProvider.roundHours(taskHours(taskType, current)),
      }))
      .sort((a, b) => b.hoursSaved - a.hoursSaved || b.count - a.count);

    const totalHours = (period: Schemas.InsightsPeriod) =>
      tasks.reduce((total, task) => total + taskHours(task.taskType, period), 0);
    const hoursSaved = InsightsProvider.roundHours(totalHours(current));
    const workingDays = Schemas.insightsWorkingDays(current, now);

    // DEV_NOTE: Weeks cut to the range. Each task's weeks are spread so they add up to its range total, then summed.
    const weeks = InsightsProvider.weeks(current);
    const weekHours = weeks.map(() => 0);
    for (const task of tasks) {
      const raw = weeks.map((week) =>
        InsightsProvider.days(week).reduce((total, day) => total + dayHours(task.taskType, day), 0),
      );
      InsightsProvider.spreadWeeks(raw).forEach((hours, at) => {
        weekHours[at] = (weekHours[at] ?? 0) + hours;
      });
    }

    return {
      current,
      previous,
      hoursSaved: {
        value: hoursSaved,
        previousValue: InsightsProvider.roundHours(totalHours(previous)),
      },
      tasksDone: impactTasks.reduce((total, task) => total + task.count, 0),
      workingDays,
      hoursPerWorkingDay:
        workingDays === 0 ? null : InsightsProvider.roundHours(hoursSaved / workingDays),
      hoursPerWeek: weeks.map((week, at) => ({
        weekStartDay: Schemas.insightsWeekStart(week.fromDay),
        hours: InsightsProvider.roundHours(weekHours[at] ?? 0),
      })),
      tasks: impactTasks,
    };
  }

  // DEV_NOTE: One task's hours per week, made non-negative with the same total as the range (never below 0). A week
  // that lost hours (users undid work done the week before) takes them from the weeks before it; what is left over at
  // the start (undos of work from before the range) comes off the weeks after. Σ result = max(0, Σ hours).
  static spreadWeeks(hours: number[]): number[] {
    const spread = [...hours];
    for (let at = spread.length - 1; at > 0; at -= 1) {
      if (spread[at]! < 0) {
        spread[at - 1]! += spread[at]!;
        spread[at] = 0;
      }
    }
    for (let at = 0; at < spread.length - 1; at += 1) {
      if (spread[at]! < 0) {
        spread[at + 1]! += spread[at]!;
        spread[at] = 0;
      }
    }
    if (spread.length > 0 && spread[spread.length - 1]! < 0) spread[spread.length - 1] = 0;
    return spread;
  }

  // ─── Index ──────────────────────────────────────────────────────────────────

  private static emptyDay(): DayTotals {
    return {
      started: 0,
      outcomes: new Map(),
      ratings: new Map(),
      changeEvents: new Map(),
      paidLiveUnits: 0n,
      paidEvalUnits: 0n,
      calls: 0,
      uses: new Map(),
      models: new Map(),
      taskNet: new Map(),
    };
  }

  private static addReading(
    day: DayTotals,
    metric: Schemas.ParsedActivityRollupMetric,
    value: string,
  ): void {
    const addTo = <K>(map: Map<K, number>, key: K, count: number) =>
      map.set(key, (map.get(key) ?? 0) + count);

    switch (metric.kind) {
      case Kind.ConversationsStarted:
        day.started += Number(value);
        return;
      case Kind.ConversationOutcome:
        addTo(day.outcomes, metric.outcome, Number(value));
        if (metric.outcome === Schemas.ConversationOutcomeIntEnum.Answered) {
          addTo(day.taskNet, Schemas.ROI_ANSWERS_TASK_TYPE, Number(value));
        }
        return;
      case Kind.Feedback:
        addTo(day.ratings, metric.rating, Number(value));
        return;
      case Kind.ChangeRequest:
        addTo(day.changeEvents, metric.action, Number(value));
        if (metric.action === Schemas.ChangeRequestEntityActionEnum.Verified) {
          addTo(day.taskNet, Schemas.roiToolTaskType(metric.toolName), Number(value));
        }
        return;
      case Kind.ChangeRequestUserUndone:
        addTo(day.taskNet, Schemas.roiToolTaskType(metric.toolName), -Number(value));
        return;
      case Kind.ModelCallTask: {
        const use = InsightsProvider.useOf(metric.scope, metric.taskType);
        if (use === null) return;
        const total = day.uses.get(use) ?? { calls: 0, tokens: 0, units: 0n };
        day.uses.set(use, total);
        if (metric.measure === Measure.Count) total.calls += Number(value);
        if (metric.measure === Measure.InputTokens || metric.measure === Measure.OutputTokens) {
          total.tokens += Number(value);
        }
        if (metric.measure === Measure.CostUsd) {
          total.units += Utility.toUnits(value, COST_SCALE);
        }
        return;
      }
      case Kind.ModelCallModel: {
        const key = `${metric.provider}/${metric.model}`;
        const total = day.models.get(key) ?? {
          provider: metric.provider,
          model: metric.model,
          calls: 0,
          units: 0n,
        };
        day.models.set(key, total);
        if (metric.measure === Measure.Count) {
          total.calls += Number(value);
          day.calls += Number(value);
        }
        if (metric.measure === Measure.CostUsd) {
          const units = Utility.toUnits(value, COST_SCALE);
          total.units += units;
          if (!Schemas.isPlatformPaidProvider(metric.provider)) {
            if (metric.scope === Scope.Eval) day.paidEvalUnits += units;
            else day.paidLiveUnits += units;
          }
        }
        return;
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private static days(period: Schemas.InsightsPeriod): Schemas.ActivityRollupDay[] {
    return Schemas.activityRollupDays(period.fromDay, period.toDay);
  }

  // The weeks (Monday start) a period covers, each cut to the period
  private static weeks(period: Schemas.InsightsPeriod): Schemas.InsightsPeriod[] {
    const weeks: Schemas.InsightsPeriod[] = [];
    let fromDay = period.fromDay;
    while (fromDay <= period.toDay) {
      const weekEnd = Schemas.activityRollupAddDays(Schemas.insightsWeekStart(fromDay), 6);
      const toDay = weekEnd < period.toDay ? weekEnd : period.toDay;
      weeks.push({ fromDay, toDay });
      fromDay = Schemas.activityRollupAddDays(toDay, 1);
    }
    return weeks;
  }

  private static sum(
    index: DayIndex,
    period: Schemas.InsightsPeriod,
    pick: (day: DayTotals) => number,
  ): number {
    let total = 0;
    for (const day of InsightsProvider.days(period)) {
      const totals = index.get(day);
      if (totals) total += pick(totals);
    }
    return total;
  }

  private static sumUnits(
    index: DayIndex,
    period: Schemas.InsightsPeriod,
    pick: (day: DayTotals) => bigint,
  ): bigint {
    let total = 0n;
    for (const day of InsightsProvider.days(period)) {
      const totals = index.get(day);
      if (totals) total += pick(totals);
    }
    return total;
  }

  // Cost the company pays (its own key); scope = one scope only, else live + eval
  private static spendUsd(
    index: DayIndex,
    period: Schemas.InsightsPeriod,
    scope?: Schemas.ActivityRollupModelCallScopeEnum,
  ): string {
    const units = InsightsProvider.sumUnits(index, period, (day) =>
      scope === Scope.Eval
        ? day.paidEvalUnits
        : scope === Scope.Live
          ? day.paidLiveUnits
          : day.paidLiveUnits + day.paidEvalUnits,
    );
    return Utility.fromUnits(units, COST_SCALE);
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
    index: DayIndex,
    period: Schemas.InsightsPeriod,
  ): Schemas.InsightsUsageRow[] {
    const totals = new Map<Schemas.InsightsUsageUseEnum, UseTotal>();
    for (const day of InsightsProvider.days(period)) {
      for (const [use, dayTotal] of index.get(day)?.uses ?? []) {
        const total = totals.get(use) ?? { calls: 0, tokens: 0, units: 0n };
        total.calls += dayTotal.calls;
        total.tokens += dayTotal.tokens;
        total.units += dayTotal.units;
        totals.set(use, total);
      }
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
          costUsd: Utility.fromUnits(total.units, COST_SCALE),
          isIncluded: use === Schemas.InsightsUsageUseEnum.Search,
        };
      });
  }

  private static byModel(
    index: DayIndex,
    period: Schemas.InsightsPeriod,
  ): Schemas.InsightsModelRow[] {
    const totals = new Map<string, ModelTotal>();
    for (const day of InsightsProvider.days(period)) {
      for (const [key, dayTotal] of index.get(day)?.models ?? []) {
        const total = totals.get(key) ?? { ...dayTotal, calls: 0, units: 0n };
        total.calls += dayTotal.calls;
        total.units += dayTotal.units;
        totals.set(key, total);
      }
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
        costUsd: Utility.fromUnits(total.units, COST_SCALE),
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
