import { z } from "zod";
import { BudgetRefusalEnum } from "../budget/BudgetCommon";
import {
  WIDGET_FEEDBACK_FRAME_TYPE,
  WIDGET_HOST_TOKEN_FRAME_TYPE,
  WidgetChatFrameTypeEnum,
} from "../conversations/ConversationsWidgetFrames";
import { FeedbackRatingIntEnum } from "../feedback/FeedbackCommon";
import { WIDGET_SUBPROTOCOL } from "../widgetAuth/WidgetAuthCommon";

// DEV_NOTE: The load test (M6-5, docs/runbooks/load.md): what the launch gate holds the platform to, and the
// numbers the harness and the backend share.
//
// Target (Development Plan › Open questions): LOAD_TEST_TARGET_CONCURRENT_CHATS chats of one company open at once, each
// sending turns, with no 5xx and no lost or double-counted spend; BudgetDO's admit / reserve / settle at most
// LOAD_TEST_BUDGET_OP_P95_MAX_MS at the 95th percentile; outbox lag (an event written → relayed) at most
// LOAD_TEST_OUTBOX_LAG_P95_MAX_MS at the 95th percentile.
export const LOAD_TEST_TARGET_CONCURRENT_CHATS = 50;
export const LOAD_TEST_BUDGET_OP_P95_MAX_MS = 250;
export const LOAD_TEST_OUTBOX_LAG_P95_MAX_MS = 60_000;

// DEV_NOTE: A company key that starts with this is a stub key: with MODEL_BASE_URL_OVERRIDE set (staging only), its
// model calls and its key check go to the stub model (apps/test-host), never to AI Gateway or a provider. Any other
// key ignores the override, so it can't redirect a real company's calls even if it is set by mistake.
export const LOAD_STUB_MODEL_KEY_PREFIX = "diletta-load-stub-";

// DEV_NOTE: BudgetDO keeps the last samples of each operation in memory (lost when the DO is evicted; the summary says
// since when it counts)
export const BUDGET_TIMING_MAX_SAMPLES = 5_000;

// DEV_NOTE: The most one contention hold may take, in micro-dollars ($1,000)
export const LOAD_CONTENTION_MAX_AMOUNT_MICROS = 1_000_000_000;

// The BudgetDO operations whose time is kept
export enum BudgetTimedOperationEnum {
  AdmitTurn = "admitTurn",
  Reserve = "reserve",
  Settle = "settle",
}

// ─── Timings ────────────────────────────────────────────────────────────────

export const ZBudgetOperationTimings = z
  .object({
    count: z.number().int().min(0),
    p50Ms: z.number().min(0),
    p95Ms: z.number().min(0),
    maxMs: z.number().min(0),
  })
  .meta({ id: "BudgetOperationTimings" });
export type BudgetOperationTimings = z.infer<typeof ZBudgetOperationTimings>;

export const ZBudgetTimings = z
  .object({
    admitTurn: ZBudgetOperationTimings,
    reserve: ZBudgetOperationTimings,
    settle: ZBudgetOperationTimings,
  })
  .meta({ id: "BudgetTimings" });
export type BudgetTimings = z.infer<typeof ZBudgetTimings>;

// DEV_NOTE: Nearest-rank percentile of an ascending list (q in 0..1): the smallest sample that at least q of the
// samples are at or below. Empty list → 0.
export function percentile(sortedAscending: readonly number[], q: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.min(sortedAscending.length, Math.max(1, Math.ceil(q * sortedAscending.length)));
  return sortedAscending[rank - 1];
}

// DEV_NOTE: The count and the p50 / p95 / max of a list of durations in milliseconds
export function summarizeDurations(samples: readonly number[]): BudgetOperationTimings {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
}

// ─── Budget snapshot ────────────────────────────────────────────────────────

// DEV_NOTE: What BudgetDO holds for the company right now. spentMicros = settled spend this period, heldMicros = what
// open reservations hold (an expired one is counted in spentMicros first), all in micro-dollars. timingsSince = when
// (epoch milliseconds) the timings below began counting: a DO evicted mid-run starts over, which shows as a later value.
export const ZBudgetSnapshot = z
  .object({
    spentMicros: z.number().int().min(0),
    budgetMicros: z.number().int().min(0),
    heldMicros: z.number().int().min(0),
    openReservationCount: z.number().int().min(0),
  })
  .meta({ id: "BudgetSnapshot" });
export type BudgetSnapshot = z.infer<typeof ZBudgetSnapshot>;

// ─── Model call and outbox aggregates ───────────────────────────────────────

// DEV_NOTE: The company's model_calls rows since the window began. costMicros = the sum of cost_usd in micro-dollars;
// pendingCount = calls whose cost isn't final yet (a stub call never is).
export const ZLoadModelCallStats = z
  .object({
    callCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    costMicros: z.number().int().min(0),
  })
  .meta({ id: "LoadModelCallStats" });
export type LoadModelCallStats = z.infer<typeof ZLoadModelCallStats>;

// DEV_NOTE: The company's event_outbox rows created since the window began. Lag = published_at − created_at of a
// published row, in milliseconds; unpublishedCount rows are still waiting (the Cron sweep publishes what the relay missed).
export const ZLoadOutboxStats = z
  .object({
    eventCount: z.number().int().min(0),
    publishedCount: z.number().int().min(0),
    unpublishedCount: z.number().int().min(0),
    lagP50Ms: z.number().min(0),
    lagP95Ms: z.number().min(0),
    lagMaxMs: z.number().min(0),
  })
  .meta({ id: "LoadOutboxStats" });
export type LoadOutboxStats = z.infer<typeof ZLoadOutboxStats>;

// ─── Contention ─────────────────────────────────────────────────────────────

export const ZLoadBudgetRefusal = z.enum(BudgetRefusalEnum);

// DEV_NOTE: The constants the harness needs that no request or answer carries, each a literal, read by the harness
// from its generated type and never sent
export const ZEvalLoadConstants = z
  .object({
    targetConcurrentChats: z.literal(LOAD_TEST_TARGET_CONCURRENT_CHATS),
    budgetOpP95MaxMs: z.literal(LOAD_TEST_BUDGET_OP_P95_MAX_MS),
    outboxLagP95MaxMs: z.literal(LOAD_TEST_OUTBOX_LAG_P95_MAX_MS),
    stubModelKeyPrefix: z.literal(LOAD_STUB_MODEL_KEY_PREFIX),
    contentionMaxAmountMicros: z.literal(LOAD_CONTENTION_MAX_AMOUNT_MICROS),
    // DEV_NOTE: What the harness speaks on the widget's socket (/widget/ws): the subprotocol the companion JWT is offered
    // with, and the frames it sends. Think's chat response frames are the Agents SDK's own, named in the harness.
    widgetSubprotocol: z.literal(WIDGET_SUBPROTOCOL),
    widgetChatRequestFrameType: z.literal(WidgetChatFrameTypeEnum.ChatRequest),
    widgetHostTokenFrameType: z.literal(WIDGET_HOST_TOKEN_FRAME_TYPE),
    widgetFeedbackFrameType: z.literal(WIDGET_FEEDBACK_FRAME_TYPE),
    feedbackRatingDown: z.literal(FeedbackRatingIntEnum.Down),
  })
  .meta({ id: "EvalLoadConstants" });
export type EvalLoadConstants = z.infer<typeof ZEvalLoadConstants>;
