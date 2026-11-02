import { z } from "zod";
import { ConversationOutcomeIntEnum } from "../conversations";
import { ChangeRequestEntityActionEnum } from "../changeRequests";
import { FeedbackRatingIntEnum } from "../feedback";
import {
  ActivityRollupMetricKindEnum,
  ZActivityRollupDay,
  parseActivityRollupMetric,
  type ActivityRollupDay,
} from "../activityRollups/ActivityRollupsCommon";

// DEV_NOTE: Daily production health per chatbot (M5-5). Once a day the backend compares each chatbot's yesterday with
// the CHATBOT_HEALTH_BASELINE_DAYS before it, from its live activity_rollups (eval conversations are never in them),
// on three shares:
//   ThumbsDown          = feedback down / (up + down)
//   CouldntAnswer       = conversations ending idk / conversations started
//   ChangesNeedingHelp  = change requests ending NeedsHuman or Failed / every change request that ended
//                         (Verified + NeedsHuman + Failed + Rejected + Expired)
// A signal drops when both yesterday and the baseline have at least CHATBOT_HEALTH_MIN_VOLUME of its denominator (a
// handful of chats moves a share by chance) and yesterday's share is at least CHATBOT_HEALTH_MIN_RISE_POINTS
// percentage points above the baseline's. Pure, so the thresholds are unit-tested; ChatbotHealthRepo runs it.

export const CHATBOT_HEALTH_BASELINE_DAYS = 7;
export const CHATBOT_HEALTH_MIN_RISE_POINTS = 15;

export enum ChatbotHealthSignalEnum {
  ThumbsDown = "thumbs_down",
  CouldntAnswer = "couldnt_answer",
  ChangesNeedingHelp = "changes_needing_help",
}

export const CHATBOT_HEALTH_MIN_VOLUME: Record<ChatbotHealthSignalEnum, number> = {
  [ChatbotHealthSignalEnum.ThumbsDown]: 10,
  [ChatbotHealthSignalEnum.CouldntAnswer]: 20,
  [ChatbotHealthSignalEnum.ChangesNeedingHelp]: 5,
};

// DEV_NOTE: How a signal reads in the issue's note (DESIGN.md §8: no internal names)
export const CHATBOT_HEALTH_SIGNAL_LABEL_MAP: Record<ChatbotHealthSignalEnum, string> = {
  [ChatbotHealthSignalEnum.ThumbsDown]: "Replies rated down",
  [ChatbotHealthSignalEnum.CouldntAnswer]: "Conversations it couldn't answer",
  [ChatbotHealthSignalEnum.ChangesNeedingHelp]: "Changes that needed help or failed",
};

// DEV_NOTE: One signal's numerator (hits) and denominator (total) over a span of days
export type ChatbotHealthCounts = Record<ChatbotHealthSignalEnum, { hits: number; total: number }>;

const CHANGE_REQUEST_FAILED_ACTIONS: ReadonlySet<string> = new Set([
  ChangeRequestEntityActionEnum.NeedsHuman,
  ChangeRequestEntityActionEnum.Failed,
]);
const CHANGE_REQUEST_ENDED_ACTIONS: ReadonlySet<string> = new Set([
  ChangeRequestEntityActionEnum.Verified,
  ChangeRequestEntityActionEnum.NeedsHuman,
  ChangeRequestEntityActionEnum.Failed,
  ChangeRequestEntityActionEnum.Rejected,
  ChangeRequestEntityActionEnum.Expired,
]);

export function emptyChatbotHealthCounts(): ChatbotHealthCounts {
  return {
    [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 0, total: 0 },
    [ChatbotHealthSignalEnum.CouldntAnswer]: { hits: 0, total: 0 },
    [ChatbotHealthSignalEnum.ChangesNeedingHelp]: { hits: 0, total: 0 },
  };
}

// DEV_NOTE: The counts of one chatbot's rollup rows (any span of days), through the metric parser: a key it doesn't
// know is skipped. Undone and user-undone changes aren't endings of a change request here.
export function chatbotHealthCounts(
  rows: { metric: string; value: string }[],
): ChatbotHealthCounts {
  const counts = emptyChatbotHealthCounts();
  for (const row of rows) {
    const parsed = parseActivityRollupMetric(row.metric);
    const value = Number(row.value);
    if (!parsed || !Number.isFinite(value)) continue;
    if (parsed.kind === ActivityRollupMetricKindEnum.Feedback) {
      counts[ChatbotHealthSignalEnum.ThumbsDown].total += value;
      if (parsed.rating === FeedbackRatingIntEnum.Down) {
        counts[ChatbotHealthSignalEnum.ThumbsDown].hits += value;
      }
    } else if (parsed.kind === ActivityRollupMetricKindEnum.ConversationsStarted) {
      counts[ChatbotHealthSignalEnum.CouldntAnswer].total += value;
    } else if (
      parsed.kind === ActivityRollupMetricKindEnum.ConversationOutcome &&
      parsed.outcome === ConversationOutcomeIntEnum.Idk
    ) {
      counts[ChatbotHealthSignalEnum.CouldntAnswer].hits += value;
    } else if (
      parsed.kind === ActivityRollupMetricKindEnum.ChangeRequest &&
      CHANGE_REQUEST_ENDED_ACTIONS.has(parsed.action)
    ) {
      counts[ChatbotHealthSignalEnum.ChangesNeedingHelp].total += value;
      if (CHANGE_REQUEST_FAILED_ACTIONS.has(parsed.action)) {
        counts[ChatbotHealthSignalEnum.ChangesNeedingHelp].hits += value;
      }
    }
  }
  return counts;
}

// DEV_NOTE: One signal that dropped: yesterday's and the baseline's share, as whole percents
export const ZChatbotHealthDrop = z.object({
  signal: z.enum(ChatbotHealthSignalEnum),
  percent: z.number().int().min(0).max(100),
  baselinePercent: z.number().int().min(0).max(100),
});
export type ChatbotHealthDrop = z.infer<typeof ZChatbotHealthDrop>;

const percentOf = (hits: number, total: number) =>
  Math.round((Math.min(hits, total) / total) * 100);

// DEV_NOTE: The signals that dropped, in ChatbotHealthSignalEnum order; [] = healthy (or too little traffic to tell)
export function evaluateChatbotHealth(params: {
  day: ChatbotHealthCounts;
  baseline: ChatbotHealthCounts;
}): ChatbotHealthDrop[] {
  const drops: ChatbotHealthDrop[] = [];
  for (const signal of Object.values(ChatbotHealthSignalEnum)) {
    const day = params.day[signal];
    const baseline = params.baseline[signal];
    const minVolume = CHATBOT_HEALTH_MIN_VOLUME[signal];
    if (day.total < minVolume || baseline.total < minVolume) continue;
    const share = (Math.min(day.hits, day.total) / day.total) * 100;
    const baselineShare = (Math.min(baseline.hits, baseline.total) / baseline.total) * 100;
    if (share - baselineShare >= CHATBOT_HEALTH_MIN_RISE_POINTS) {
      drops.push({
        signal,
        percent: percentOf(day.hits, day.total),
        baselinePercent: percentOf(baseline.hits, baseline.total),
      });
    }
  }
  return drops;
}

// DEV_NOTE: The detail of a Health drop issue's opened / health_drop_added event: the day it is about and what dropped.
// The open issue covers a day once one of its events names it, so a rerun of the check adds nothing.
export const ZChatbotHealthDropDetail = z.object({
  day: ZActivityRollupDay,
  drops: z.array(ZChatbotHealthDrop).min(1),
});
export type ChatbotHealthDropDetail = z.infer<typeof ZChatbotHealthDropDetail>;

// DEV_NOTE: The note's sentence for one day, e.g. "Oct 30: replies rated down 31% (usually 8%); conversations it
// couldn't answer 40% (usually 12%)." Dates in UTC, as the rollup days are.
export function chatbotHealthNote(day: ActivityRollupDay, drops: ChatbotHealthDrop[]): string {
  const date = new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const parts = drops.map((drop, index) => {
    const label = CHATBOT_HEALTH_SIGNAL_LABEL_MAP[drop.signal];
    const text = index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
    return `${text} ${drop.percent}% (usually ${drop.baselinePercent}%)`;
  });
  return `${date}: ${parts.join("; ")}.`;
}

const EARLIER_DAYS_LINE = /^…and (\d+) earlier lines? \(see the activity log\)$/;

// DEV_NOTE: An open issue's note with one more day, held to noteMaxChars so the admin can always still save it: the oldest
// lines give way to a count (the events keep every day's detail). The newest line always stays.
export function appendChatbotHealthNote(
  currentNote: string | null,
  sentence: string,
  noteMaxChars: number,
): string {
  const lines = currentNote ? currentNote.split("\n") : [];
  const counted = lines[0]?.match(EARLIER_DAYS_LINE);
  let dropped = counted ? Number(counted[1]) : 0;
  if (counted) lines.shift();
  lines.push(sentence);

  const render = () => {
    const prefix =
      dropped === 0
        ? []
        : [`…and ${dropped} earlier ${dropped === 1 ? "line" : "lines"} (see the activity log)`];
    return [...prefix, ...lines].join("\n");
  };
  while (render().length > noteMaxChars && lines.length > 1) {
    lines.shift();
    dropped += 1;
  }
  return render();
}
