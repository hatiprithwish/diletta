import { describe, it, expect } from "vitest";
import {
  conversationOutcomeMetric,
  changeRequestRollupMetric,
  changeRequestUserUndoRollupMetric,
  ACTIVITY_ROLLUP_CONVERSATIONS_STARTED,
  ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP,
} from "../activityRollups/ActivityRollupsCommon";
import { ChangeRequestEntityActionEnum } from "../changeRequests";
import { ConversationOutcomeIntEnum } from "../conversations";
import { FeedbackRatingIntEnum } from "../feedback";
import {
  appendChatbotHealthNote,
  CHATBOT_HEALTH_MIN_RISE_POINTS,
  CHATBOT_HEALTH_MIN_VOLUME,
  ChatbotHealthSignalEnum,
  ZChatbotHealthDropDetail,
  chatbotHealthCounts,
  chatbotHealthNote,
  emptyChatbotHealthCounts,
  evaluateChatbotHealth,
  type ChatbotHealthCounts,
} from "./ChatbotHealthCommon";

const row = (metric: string, value: number) => ({ metric, value: String(value) });

function counts(
  overrides: Partial<Record<ChatbotHealthSignalEnum, { hits: number; total: number }>>,
): ChatbotHealthCounts {
  return { ...emptyChatbotHealthCounts(), ...overrides };
}

describe("chatbotHealthCounts", () => {
  it("reads each signal from its rollup keys, summed over days and tools", () => {
    const counted = chatbotHealthCounts([
      row(ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[FeedbackRatingIntEnum.Up], 6),
      row(ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[FeedbackRatingIntEnum.Down], 4),
      row(ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[FeedbackRatingIntEnum.Down], 1),
      row(ACTIVITY_ROLLUP_CONVERSATIONS_STARTED, 30),
      row(conversationOutcomeMetric(ConversationOutcomeIntEnum.Idk), 9),
      row(conversationOutcomeMetric(ConversationOutcomeIntEnum.Answered), 15),
      row(changeRequestRollupMetric(ChangeRequestEntityActionEnum.Verified, "update_record"), 5),
      row(changeRequestRollupMetric(ChangeRequestEntityActionEnum.NeedsHuman, "update_record"), 2),
      row(changeRequestRollupMetric(ChangeRequestEntityActionEnum.Failed, "create_record"), 1),
      row(changeRequestRollupMetric(ChangeRequestEntityActionEnum.Rejected, "create_record"), 1),
      // DEV_NOTE: An undo isn't how a change request ended
      row(changeRequestRollupMetric(ChangeRequestEntityActionEnum.Undone, "update_record"), 3),
      row(changeRequestUserUndoRollupMetric("update_record"), 3),
      row("a.metric.added.later", 100),
    ]);
    expect(counted).toEqual({
      [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 5, total: 11 },
      [ChatbotHealthSignalEnum.CouldntAnswer]: { hits: 9, total: 30 },
      [ChatbotHealthSignalEnum.ChangesNeedingHelp]: { hits: 3, total: 9 },
    });
  });
});

describe("evaluateChatbotHealth", () => {
  const minRatings = CHATBOT_HEALTH_MIN_VOLUME[ChatbotHealthSignalEnum.ThumbsDown];

  it("flags a share that rose by the minimum points over the baseline, both with enough volume", () => {
    const drops = evaluateChatbotHealth({
      day: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 5, total: 20 } }),
      baseline: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 7, total: 70 } }),
    });
    expect(drops).toEqual([
      { signal: ChatbotHealthSignalEnum.ThumbsDown, percent: 25, baselinePercent: 10 },
    ]);
  });

  it("stays quiet just under the rise, and on a share that fell", () => {
    const rise = CHATBOT_HEALTH_MIN_RISE_POINTS - 1;
    expect(
      evaluateChatbotHealth({
        day: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 10 + rise, total: 100 } }),
        baseline: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 10, total: 100 } }),
      }),
    ).toEqual([]);
    expect(
      evaluateChatbotHealth({
        day: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 0, total: 100 } }),
        baseline: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 50, total: 100 } }),
      }),
    ).toEqual([]);
  });

  it("needs the minimum volume on both sides", () => {
    const allDown = { hits: minRatings - 1, total: minRatings - 1 };
    expect(
      evaluateChatbotHealth({
        day: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: allDown }),
        baseline: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 0, total: 100 } }),
      }),
    ).toEqual([]);
    expect(
      evaluateChatbotHealth({
        day: counts({ [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 20, total: 20 } }),
        baseline: counts({
          [ChatbotHealthSignalEnum.ThumbsDown]: { hits: 0, total: minRatings - 1 },
        }),
      }),
    ).toEqual([]);
  });

  it("lists every signal that dropped, in order", () => {
    const drops = evaluateChatbotHealth({
      day: counts({
        [ChatbotHealthSignalEnum.CouldntAnswer]: { hits: 20, total: 40 },
        [ChatbotHealthSignalEnum.ChangesNeedingHelp]: { hits: 4, total: 5 },
      }),
      baseline: counts({
        [ChatbotHealthSignalEnum.CouldntAnswer]: { hits: 20, total: 200 },
        [ChatbotHealthSignalEnum.ChangesNeedingHelp]: { hits: 1, total: 50 },
      }),
    });
    expect(drops.map((drop) => drop.signal)).toEqual([
      ChatbotHealthSignalEnum.CouldntAnswer,
      ChatbotHealthSignalEnum.ChangesNeedingHelp,
    ]);
  });
});

describe("chatbotHealthNote", () => {
  it("says the day and each drop in words, with no internal names", () => {
    const note = chatbotHealthNote("2026-10-30", [
      { signal: ChatbotHealthSignalEnum.ThumbsDown, percent: 31, baselinePercent: 8 },
      { signal: ChatbotHealthSignalEnum.CouldntAnswer, percent: 40, baselinePercent: 12 },
    ]);
    expect(note).toBe(
      "Oct 30: Replies rated down 31% (usually 8%); conversations it couldn't answer 40% (usually 12%).",
    );
    expect(note).not.toMatch(/thumbs_down|couldnt_answer|idk/);
  });

  it("detail needs a day and at least one drop", () => {
    expect(ZChatbotHealthDropDetail.safeParse({ day: "2026-10-30", drops: [] }).success).toBe(
      false,
    );
  });
});

describe("appendChatbotHealthNote", () => {
  it("adds a line, starting from no note", () => {
    expect(appendChatbotHealthNote(null, "Oct 30.", 100)).toBe("Oct 30.");
    expect(appendChatbotHealthNote("Oct 30.", "Oct 31.", 100)).toBe("Oct 30.\nOct 31.");
  });

  it("stays within the cap over many days, keeping the newest and counting the rest", () => {
    let note: string | null = null;
    for (let day = 1; day <= 60; day += 1) {
      note = appendChatbotHealthNote(note, `Day ${day}: ${"x".repeat(100)}.`, 500);
      expect(note.length).toBeLessThanOrEqual(500);
    }
    const lines = (note ?? "").split("\n");
    expect(lines.at(-1)).toContain("Day 60");
    const count = Number(lines[0]?.match(/\d+/)?.[0]);
    expect(count + lines.length - 1).toBe(60);
  });

  it("counts one earlier line in the singular", () => {
    expect(appendChatbotHealthNote("a".repeat(60), "b".repeat(30), 80)).toBe(
      `…and 1 earlier line (see the activity log)\n${"b".repeat(30)}`,
    );
  });
});
