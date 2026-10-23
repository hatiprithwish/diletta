import { z } from "zod";
import { ChangeRequestEntityActionEnum } from "../changeRequests";
import { ConversationOutcomeIntEnum } from "../conversations";
import { FeedbackRatingIntEnum } from "../feedback";
import type { ModelCallProvider } from "../modelCalls";

// DEV_NOTE: Daily totals per company (chatbotId null = company-wide) and per chatbot (M4-2). Derived, never a source
// of truth: a (company, day) is rebuilt from the raw tables and activity_log as a whole. A day is a UTC date.
// A metric is a text key with its dimension inside it, built only through the helpers below so readers (M4-3) and
// the rollup agree on every key.

// DEV_NOTE: An operator rebuild covers at most this many days per request
export const ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

export const ZActivityRollupDay = z.iso.date();
export type ActivityRollupDay = z.infer<typeof ZActivityRollupDay>;

export const ACTIVITY_ROLLUP_CONVERSATIONS_STARTED = "conversations.started";

export const ACTIVITY_ROLLUP_CONVERSATION_OUTCOME_KEY_MAP: Record<
  ConversationOutcomeIntEnum,
  string
> = {
  [ConversationOutcomeIntEnum.Answered]: "answered",
  [ConversationOutcomeIntEnum.ActionDone]: "action_done",
  [ConversationOutcomeIntEnum.Idk]: "idk",
  [ConversationOutcomeIntEnum.Handoff]: "handoff",
  [ConversationOutcomeIntEnum.Abandoned]: "abandoned",
};

// DEV_NOTE: The outcome of the conversations started that day. Closing writes no activity_log row and updated_at moves
// on later writes (a purge), so the start day is the one day a conversation always keeps.
export function conversationOutcomeMetric(outcome: ConversationOutcomeIntEnum): string {
  return `conversations.outcome.${ACTIVITY_ROLLUP_CONVERSATION_OUTCOME_KEY_MAP[outcome]}`;
}

export const ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP: Record<FeedbackRatingIntEnum, string> = {
  [FeedbackRatingIntEnum.Up]: "feedback.up",
  [FeedbackRatingIntEnum.Down]: "feedback.down",
};

// DEV_NOTE: The change request events counted, by the day the event was written. A change request undone after it was
// verified counts once in each, on its own day.
export const ACTIVITY_ROLLUP_CHANGE_REQUEST_ACTIONS = [
  ChangeRequestEntityActionEnum.Verified,
  ChangeRequestEntityActionEnum.Undone,
  ChangeRequestEntityActionEnum.NeedsHuman,
  ChangeRequestEntityActionEnum.Failed,
  ChangeRequestEntityActionEnum.Rejected,
  ChangeRequestEntityActionEnum.Expired,
] as const;
export type ActivityRollupChangeRequestAction =
  (typeof ACTIVITY_ROLLUP_CHANGE_REQUEST_ACTIONS)[number];

export function changeRequestRollupMetric(
  action: ActivityRollupChangeRequestAction,
  toolName: string,
): string {
  return `change_requests.${action}.tool.${toolName}`;
}

export enum ActivityRollupModelCallMeasureEnum {
  Count = "count",
  InputTokens = "input_tokens",
  OutputTokens = "output_tokens",
  CostUsd = "cost_usd",
}

// DEV_NOTE: Which calls a model call metric counts. Live = the chatbot answering its users (and background jobs, which
// have no chatbot). Eval = calls made for an eval run (eval_run_id set), kept under their own keys even when they carry
// the chatbot under test, so a chatbot's live usage never includes its test runs. Spend in total = live + eval.
export enum ActivityRollupModelCallScopeEnum {
  Live = "live",
  Eval = "eval",
}

const MODEL_CALL_SCOPE_PREFIX: Record<ActivityRollupModelCallScopeEnum, string> = {
  [ActivityRollupModelCallScopeEnum.Live]: "model_calls",
  [ActivityRollupModelCallScopeEnum.Eval]: "model_calls.eval",
};

export function modelCallTaskRollupMetric(
  scope: ActivityRollupModelCallScopeEnum,
  measure: ActivityRollupModelCallMeasureEnum,
  taskType: string,
): string {
  return `${MODEL_CALL_SCOPE_PREFIX[scope]}.${measure}.task.${taskType}`;
}

export function modelCallModelRollupMetric(
  scope: ActivityRollupModelCallScopeEnum,
  measure: ActivityRollupModelCallMeasureEnum,
  provider: ModelCallProvider,
  model: string,
): string {
  return `${MODEL_CALL_SCOPE_PREFIX[scope]}.${measure}.model.${provider}/${model}`;
}

// DEV_NOTE: The UTC day an instant falls on, and the half-open range [start, end) a day covers
export function activityRollupDayKey(now: number): ActivityRollupDay {
  return new Date(now).toISOString().slice(0, 10);
}

export function activityRollupDayRange(day: ActivityRollupDay): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

// How many days fromDay to toDay covers, both included (0 or less when reversed). Arithmetic, so checking a range
// against the rebuild cap costs nothing however far apart the days are.
export function activityRollupDayCount(
  fromDay: ActivityRollupDay,
  toDay: ActivityRollupDay,
): number {
  const span =
    activityRollupDayRange(toDay).start.getTime() - activityRollupDayRange(fromDay).start.getTime();
  return span / DAY_MS + 1;
}

// Every day from fromDay to toDay, both included, oldest first. Callers bound the range first (the rebuild cap).
export function activityRollupDays(
  fromDay: ActivityRollupDay,
  toDay: ActivityRollupDay,
): ActivityRollupDay[] {
  const days: ActivityRollupDay[] = [];
  const end = activityRollupDayRange(toDay).start.getTime();
  for (let at = activityRollupDayRange(fromDay).start.getTime(); at <= end; at += DAY_MS) {
    days.push(activityRollupDayKey(at));
  }
  return days;
}

// DEV_NOTE: The days the hourly run rebuilds at an instant: yesterday and today (UTC), oldest first
export function activityRollupRecentDays(now: number): ActivityRollupDay[] {
  return [activityRollupDayKey(now - DAY_MS), activityRollupDayKey(now)];
}

// One metric of one day, before it is stored. value is a decimal string (numeric column, exact)
export const ZActivityRollupValue = z.object({
  chatbotId: z.string().nullable(),
  metric: z.string().min(1),
  value: z.string(),
});
export type ActivityRollupValue = z.infer<typeof ZActivityRollupValue>;

// Whole Activity Rollup Body — DB shape
// DEV_NOTE: Derived, so no publicId or updatedAt; rows never reach a client as-is (M4-3 maps them)
export const ZActivityRollup = ZActivityRollupValue.extend({
  id: z.string(),
  companyId: z.string(),
  day: ZActivityRollupDay,
});
export type ActivityRollup = z.infer<typeof ZActivityRollup>;

// DEV_NOTE: The day n days after (or before, n < 0) a day
export function activityRollupAddDays(day: ActivityRollupDay, days: number): ActivityRollupDay {
  return activityRollupDayKey(activityRollupDayRange(day).start.getTime() + days * DAY_MS);
}

// DEV_NOTE: The reading side of the metric keys (M4-3): one stored key back into what it counts. The inverse of the
// builders above, so the pages never match a key by hand. A key no builder makes (a metric added later) parses to null
// and the pages skip it.
export enum ActivityRollupMetricKindEnum {
  ConversationsStarted = "conversations_started",
  ConversationOutcome = "conversation_outcome",
  Feedback = "feedback",
  ChangeRequest = "change_request",
  ModelCallTask = "model_call_task",
  ModelCallModel = "model_call_model",
}

export type ParsedActivityRollupMetric =
  | { kind: ActivityRollupMetricKindEnum.ConversationsStarted }
  | { kind: ActivityRollupMetricKindEnum.ConversationOutcome; outcome: ConversationOutcomeIntEnum }
  | { kind: ActivityRollupMetricKindEnum.Feedback; rating: FeedbackRatingIntEnum }
  | {
      kind: ActivityRollupMetricKindEnum.ChangeRequest;
      action: ActivityRollupChangeRequestAction;
      toolName: string;
    }
  | {
      kind: ActivityRollupMetricKindEnum.ModelCallTask;
      scope: ActivityRollupModelCallScopeEnum;
      measure: ActivityRollupModelCallMeasureEnum;
      taskType: string;
    }
  | {
      kind: ActivityRollupMetricKindEnum.ModelCallModel;
      scope: ActivityRollupModelCallScopeEnum;
      measure: ActivityRollupModelCallMeasureEnum;
      provider: string;
      model: string;
    };

const OUTCOME_BY_KEY = new Map(
  Object.entries(ACTIVITY_ROLLUP_CONVERSATION_OUTCOME_KEY_MAP).map(([outcome, key]) => [
    `conversations.outcome.${key}`,
    Number(outcome) as ConversationOutcomeIntEnum,
  ]),
);
const RATING_BY_KEY = new Map(
  Object.entries(ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP).map(([rating, key]) => [
    key,
    Number(rating) as FeedbackRatingIntEnum,
  ]),
);
const CHANGE_REQUEST_ACTIONS: ReadonlySet<string> = new Set(ACTIVITY_ROLLUP_CHANGE_REQUEST_ACTIONS);
const MODEL_CALL_MEASURES: ReadonlySet<string> = new Set(
  Object.values(ActivityRollupModelCallMeasureEnum),
);

function parseModelCallMetric(
  scope: ActivityRollupModelCallScopeEnum,
  rest: string,
): ParsedActivityRollupMetric | null {
  const dot = rest.indexOf(".");
  const measure = rest.slice(0, dot);
  if (dot < 0 || !MODEL_CALL_MEASURES.has(measure)) return null;
  const dimension = rest.slice(dot + 1);
  const typedMeasure = measure as ActivityRollupModelCallMeasureEnum;

  if (dimension.startsWith("task.")) {
    const taskType = dimension.slice("task.".length);
    if (!taskType) return null;
    return {
      kind: ActivityRollupMetricKindEnum.ModelCallTask,
      scope,
      measure: typedMeasure,
      taskType,
    };
  }
  if (dimension.startsWith("model.")) {
    // DEV_NOTE: The provider never holds a "/", the model may (@cf/baai/bge-m3), so the first "/" splits them
    const providerModel = dimension.slice("model.".length);
    const slash = providerModel.indexOf("/");
    if (slash <= 0 || slash === providerModel.length - 1) return null;
    return {
      kind: ActivityRollupMetricKindEnum.ModelCallModel,
      scope,
      measure: typedMeasure,
      provider: providerModel.slice(0, slash),
      model: providerModel.slice(slash + 1),
    };
  }
  return null;
}

export function parseActivityRollupMetric(metric: string): ParsedActivityRollupMetric | null {
  if (metric === ACTIVITY_ROLLUP_CONVERSATIONS_STARTED) {
    return { kind: ActivityRollupMetricKindEnum.ConversationsStarted };
  }
  const outcome = OUTCOME_BY_KEY.get(metric);
  if (outcome !== undefined) {
    return { kind: ActivityRollupMetricKindEnum.ConversationOutcome, outcome };
  }
  const rating = RATING_BY_KEY.get(metric);
  if (rating !== undefined) return { kind: ActivityRollupMetricKindEnum.Feedback, rating };

  if (metric.startsWith("change_requests.")) {
    const rest = metric.slice("change_requests.".length);
    const marker = rest.indexOf(".tool.");
    const action = rest.slice(0, marker);
    const toolName = rest.slice(marker + ".tool.".length);
    if (marker < 0 || !CHANGE_REQUEST_ACTIONS.has(action) || !toolName) return null;
    return {
      kind: ActivityRollupMetricKindEnum.ChangeRequest,
      action: action as ActivityRollupChangeRequestAction,
      toolName,
    };
  }

  // DEV_NOTE: The eval prefix first: model_calls.eval.* also starts with model_calls.
  const evalPrefix = `${MODEL_CALL_SCOPE_PREFIX[ActivityRollupModelCallScopeEnum.Eval]}.`;
  if (metric.startsWith(evalPrefix)) {
    return parseModelCallMetric(
      ActivityRollupModelCallScopeEnum.Eval,
      metric.slice(evalPrefix.length),
    );
  }
  const livePrefix = `${MODEL_CALL_SCOPE_PREFIX[ActivityRollupModelCallScopeEnum.Live]}.`;
  if (metric.startsWith(livePrefix)) {
    return parseModelCallMetric(
      ActivityRollupModelCallScopeEnum.Live,
      metric.slice(livePrefix.length),
    );
  }
  return null;
}

// One stored rollup row as the pages read it: no ids, the day and the exact decimal value
export type ActivityRollupReading = { day: ActivityRollupDay; metric: string; value: string };
