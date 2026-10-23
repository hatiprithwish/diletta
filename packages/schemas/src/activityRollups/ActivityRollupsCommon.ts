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

export function modelCallTaskRollupMetric(
  measure: ActivityRollupModelCallMeasureEnum,
  taskType: string,
): string {
  return `model_calls.${measure}.task.${taskType}`;
}

export function modelCallModelRollupMetric(
  measure: ActivityRollupModelCallMeasureEnum,
  provider: ModelCallProvider,
  model: string,
): string {
  return `model_calls.${measure}.model.${provider}/${model}`;
}

// DEV_NOTE: The UTC day an instant falls on, and the half-open range [start, end) a day covers
export function activityRollupDayKey(now: number): ActivityRollupDay {
  return new Date(now).toISOString().slice(0, 10);
}

export function activityRollupDayRange(day: ActivityRollupDay): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

// Every day from fromDay to toDay, both included, oldest first
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
