import {
  activityRollupAddDays,
  activityRollupDayKey,
  type ActivityRollupDay,
} from "../activityRollups/ActivityRollupsCommon";
import { ModelProviderEnum } from "../companySecrets/CompanySecretsCommon";
import { ModelTaskTypeEnum, PlatformModelProviderEnum } from "../modelCalls/ModelCallsCommon";

// DEV_NOTE: The Insights pages (M4-3): Overview, Usage and Impact. Their numbers are read from activity_rollups (M4-2,
// rebuilt hourly), so they are as fresh as the last hourly run. Days are UTC, like the rollups. Money is a decimal
// string with the 6 places of model_calls.cost_usd, summed exactly; the client only formats it.

// ─── Ranges ──────────────────────────────────────────────────────────────────

// Overview and Usage: the last N days, today included
export enum InsightsRangeEnum {
  Last7Days = "7d",
  Last30Days = "30d",
  Last90Days = "90d",
}

export const INSIGHTS_RANGE_LABEL_MAP: Record<InsightsRangeEnum, string> = {
  [InsightsRangeEnum.Last7Days]: "7 days",
  [InsightsRangeEnum.Last30Days]: "30 days",
  [InsightsRangeEnum.Last90Days]: "90 days",
};

const INSIGHTS_RANGE_DAYS: Record<InsightsRangeEnum, number> = {
  [InsightsRangeEnum.Last7Days]: 7,
  [InsightsRangeEnum.Last30Days]: 30,
  [InsightsRangeEnum.Last90Days]: 90,
};

export const DEFAULT_INSIGHTS_RANGE = InsightsRangeEnum.Last30Days;

// Impact: calendar months (time saved is reported per month), or the last 90 days
export enum ImpactRangeEnum {
  ThisMonth = "this_month",
  LastMonth = "last_month",
  Last90Days = "90d",
}

export const IMPACT_RANGE_LABEL_MAP: Record<ImpactRangeEnum, string> = {
  [ImpactRangeEnum.ThisMonth]: "This month",
  [ImpactRangeEnum.LastMonth]: "Last month",
  [ImpactRangeEnum.Last90Days]: "90 days",
};

export const DEFAULT_IMPACT_RANGE = ImpactRangeEnum.ThisMonth;

// Both days included
export type InsightsPeriod = { fromDay: ActivityRollupDay; toDay: ActivityRollupDay };

// DEV_NOTE: A range and the period its deltas compare against
export type InsightsPeriods = { current: InsightsPeriod; previous: InsightsPeriod };

function monthStart(day: ActivityRollupDay): ActivityRollupDay {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(day: ActivityRollupDay): ActivityRollupDay {
  return activityRollupAddDays(nextMonthStart(day), -1);
}

function nextMonthStart(day: ActivityRollupDay): ActivityRollupDay {
  // DEV_NOTE: Day 28 + 4 days always lands in the next month
  return monthStart(activityRollupAddDays(`${day.slice(0, 7)}-28`, 4));
}

function previousMonthStart(day: ActivityRollupDay): ActivityRollupDay {
  return monthStart(activityRollupAddDays(monthStart(day), -1));
}

// The UTC billing month (BudgetDO, M2-4) an instant falls in: its first day, and the day it resets
export function insightsBillingMonth(now: number): {
  fromDay: ActivityRollupDay;
  toDay: ActivityRollupDay;
  resetsOnDay: ActivityRollupDay;
} {
  const today = activityRollupDayKey(now);
  return { fromDay: monthStart(today), toDay: today, resetsOnDay: nextMonthStart(today) };
}

// DEV_NOTE: The last N days up to today, compared with the N days before them
export function insightsRangePeriods(range: InsightsRangeEnum, now: number): InsightsPeriods {
  const days = INSIGHTS_RANGE_DAYS[range];
  const toDay = activityRollupDayKey(now);
  const fromDay = activityRollupAddDays(toDay, -(days - 1));
  return {
    current: { fromDay, toDay },
    previous: {
      fromDay: activityRollupAddDays(fromDay, -days),
      toDay: activityRollupAddDays(fromDay, -1),
    },
  };
}

// DEV_NOTE: This month runs to today and is compared with the same days of last month (1st to the same day of the
// month, cut at its last day), so a month in progress is never set against a whole one. Last month is compared with the
// month before it, whole.
export function impactRangePeriods(range: ImpactRangeEnum, now: number): InsightsPeriods {
  const today = activityRollupDayKey(now);

  if (range === ImpactRangeEnum.ThisMonth) {
    const lastMonthFrom = previousMonthStart(today);
    const sameDay = activityRollupAddDays(lastMonthFrom, Number(today.slice(8, 10)) - 1);
    const lastMonthTo = monthEnd(lastMonthFrom);
    return {
      current: { fromDay: monthStart(today), toDay: today },
      previous: { fromDay: lastMonthFrom, toDay: sameDay < lastMonthTo ? sameDay : lastMonthTo },
    };
  }

  if (range === ImpactRangeEnum.LastMonth) {
    const lastMonthFrom = previousMonthStart(today);
    const monthBeforeFrom = previousMonthStart(lastMonthFrom);
    return {
      current: { fromDay: lastMonthFrom, toDay: monthEnd(lastMonthFrom) },
      previous: { fromDay: monthBeforeFrom, toDay: monthEnd(monthBeforeFrom) },
    };
  }

  return insightsRangePeriods(InsightsRangeEnum.Last90Days, now);
}

// DEV_NOTE: Monday to Friday days of a period, counted up to today at most (a past range counts whole)
export function insightsWorkingDays(period: InsightsPeriod, now: number): number {
  const today = activityRollupDayKey(now);
  const lastDay = period.toDay < today ? period.toDay : today;
  let count = 0;
  for (let day = period.fromDay; day <= lastDay; day = activityRollupAddDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

// The Monday of the week a day falls in (weeks start on Monday)
export function insightsWeekStart(day: ActivityRollupDay): ActivityRollupDay {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return activityRollupAddDays(day, -((weekday + 6) % 7));
}

// ─── Usage: what model calls were for ────────────────────────────────────────

export enum InsightsUsageUseEnum {
  Answers = "answers",
  Routing = "routing",
  TestRuns = "test_runs",
  Search = "search",
}

export const INSIGHTS_USAGE_USE_LABEL_MAP: Record<InsightsUsageUseEnum, string> = {
  [InsightsUsageUseEnum.Answers]: "Answers",
  [InsightsUsageUseEnum.Routing]: "Routing",
  [InsightsUsageUseEnum.TestRuns]: "Test runs (incl. judge)",
  [InsightsUsageUseEnum.Search]: "Search embeddings + rerank",
};

// DEV_NOTE: A live call's use, by its task type. Every call made for an eval run is a test run whatever its task
// type (the Eval scope's keys), so this map is read for live calls only.
export const INSIGHTS_TASK_TYPE_USE_MAP: Record<ModelTaskTypeEnum, InsightsUsageUseEnum> = {
  [ModelTaskTypeEnum.QaAnswer]: InsightsUsageUseEnum.Answers,
  [ModelTaskTypeEnum.RouteIntent]: InsightsUsageUseEnum.Routing,
  [ModelTaskTypeEnum.EvalJudge]: InsightsUsageUseEnum.TestRuns,
  [ModelTaskTypeEnum.QualityTestRewrite]: InsightsUsageUseEnum.TestRuns,
  [ModelTaskTypeEnum.KnowledgeEmbed]: InsightsUsageUseEnum.Search,
  [ModelTaskTypeEnum.SearchEmbed]: InsightsUsageUseEnum.Search,
  [ModelTaskTypeEnum.SearchRerank]: InsightsUsageUseEnum.Search,
};

// DEV_NOTE: Calls the platform pays for (Workers AI embeddings and rerank): shown as "Included", never in a spend
// total, like the budget leaves them out (M2-5)
export function isPlatformPaidProvider(provider: string): boolean {
  return (Object.values(PlatformModelProviderEnum) as string[]).includes(provider);
}

export const INSIGHTS_PROVIDER_LABEL_MAP: Record<
  ModelProviderEnum | PlatformModelProviderEnum,
  string
> = {
  [ModelProviderEnum.Google]: "Google",
  [ModelProviderEnum.OpenAI]: "OpenAI",
  [ModelProviderEnum.Anthropic]: "Anthropic",
  [PlatformModelProviderEnum.WorkersAi]: "Cloudflare Workers AI",
};

// ─── Shapes ──────────────────────────────────────────────────────────────────

export type InsightsCount = { value: number; previousValue: number };

export type InsightsRate = { value: number | null; previousValue: number | null };

export type InsightsDayCount = { day: ActivityRollupDay; value: number };

export type InsightsDayCost = { day: ActivityRollupDay; costUsd: string };

export type InsightsOverviewAttention = {
  needsHumanCount: number;
  openIssueCount: number;
  openUserIssueCount: number;
  failedSourceCount: number;
  lastSourceFailedAt: string | null; // ISO time
};

// DEV_NOTE: The chatbot shown (the botId's, else the company's default) and its live config; published null = it has
// no published config yet. publishedByName null = published by the system, or by an admin since removed.
export type InsightsLiveConfig = {
  chatbotName: string;
  published: {
    configVersion: number;
    publishedAt: string | null; // ISO time
    publishedByName: string | null;
  } | null;
};

// DEV_NOTE: Spend of the UTC billing month, whatever the range: the budget resets monthly. spentUsd includes the test
// runs (testRunsUsd), like the budget does; platform-paid calls are in neither.
export type InsightsMonthSpend = {
  fromDay: ActivityRollupDay;
  resetsOnDay: ActivityRollupDay;
  spentUsd: string;
  testRunsUsd: string;
  budgetUsd: string;
};

// DEV_NOTE: answeredRate = (answered + action done) / closed with an answer or a handoff (abandoned conversations left
// out); helpfulRate = up / rated. A rate with nothing to divide by is null.
export type InsightsOverview = InsightsPeriods & {
  conversations: InsightsCount;
  answeredRate: InsightsRate;
  helpfulRate: { value: number | null; ratedCount: number };
  changes: { verified: number; undone: number; needsHuman: number };
  conversationsPerDay: InsightsDayCount[];
  monthSpend: InsightsMonthSpend;
  attention: InsightsOverviewAttention;
  liveConfig: InsightsLiveConfig | null;
};

export type InsightsUsageRow = {
  use: InsightsUsageUseEnum;
  useLabel: string;
  calls: number;
  tokens: number; // input + output
  costUsd: string;
  isIncluded: boolean; // platform-paid: no cost to the company
};

export type InsightsModelRow = {
  provider: string;
  providerLabel: string;
  model: string;
  calls: number;
  costUsd: string;
  isIncluded: boolean;
};

export type InsightsUsage = InsightsPeriods & {
  spend: { valueUsd: string; previousValueUsd: string; testRunsUsd: string };
  modelCalls: InsightsCount;
  costPerConversation: { valueUsd: string | null; previousValueUsd: string | null };
  spendPerDay: InsightsDayCost[];
  byUse: InsightsUsageRow[];
  byModel: InsightsModelRow[];
};

// ─── Impact: tasks and time saved ────────────────────────────────────────────

export enum ImpactTaskKindEnum {
  Tool = "tool",
  Answers = "answers",
}

export type InsightsImpactTask = {
  taskType: string; // roi_assumptions.task_type
  kind: ImpactTaskKindEnum;
  toolName: string | null;
  label: string;
  count: number;
  manualMinutes: string | null; // the minutes in force today; null = not set
  hoursSaved: number;
};

export type InsightsWeekHours = { weekStartDay: ActivityRollupDay; hours: number };

export type InsightsImpact = InsightsPeriods & {
  hoursSaved: { value: number; previousValue: number };
  tasksDone: number;
  workingDays: number;
  hoursPerWorkingDay: number | null;
  hoursPerWeek: InsightsWeekHours[];
  tasks: InsightsImpactTask[];
};
