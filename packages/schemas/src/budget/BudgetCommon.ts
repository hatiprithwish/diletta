import { z } from "zod";

// DEV_NOTE: Why the budget refused a turn or a model call (M2-4). Logged only: the widget sees
// BUDGET_RATE_LIMIT_MESSAGE for the two rate limits and MODEL_UNAVAILABLE_MESSAGE for everything else.
//   CompanyBudget: the company's spending_budget for this billing period is used up (or would be by this call).
//   UserDailyCost: the chatbot user's userDailyCostCapUsd for today (UTC) is used up.
//   UserMessageRate: the chatbot user sent more than userMessagesPerMinute messages in the last minute.
//   ConversationTurnRate: the conversation had conversationTurnsPerHour turns in the last hour.
//   ConversationCost: the conversation's conversationCostCapUsd is used up.
//   TurnCost / TurnTokens: the turn's turnCostCapUsd / maxTokensPerTurn is used up.
//   Unavailable: the budget couldn't be read or reached (fail closed: no call goes out uncounted).
export enum BudgetRefusalEnum {
  CompanyBudget = "CompanyBudget",
  UserDailyCost = "UserDailyCost",
  UserMessageRate = "UserMessageRate",
  ConversationTurnRate = "ConversationTurnRate",
  ConversationCost = "ConversationCost",
  TurnCost = "TurnCost",
  TurnTokens = "TurnTokens",
  Unavailable = "Unavailable",
}

// DEV_NOTE: The refusals that are about pace, not money: the widget asks the user to wait instead of showing its
// unavailable state
export const BUDGET_RATE_LIMIT_REFUSALS: ReadonlySet<BudgetRefusalEnum> = new Set([
  BudgetRefusalEnum.UserMessageRate,
  BudgetRefusalEnum.ConversationTurnRate,
]);

// DEV_NOTE: DESIGN.md §8 copy for a rate limit (widget error frame)
export const BUDGET_RATE_LIMIT_MESSAGE =
  "You're sending messages too quickly. Please wait a moment.";

// DEV_NOTE: Platform default for a company whose spending_budget is NULL (no admin has set one yet), per billing
// period. A string like the numeric(12,6) column, so the same parse applies to both.
export const DEFAULT_SPENDING_BUDGET_USD = "10.000000";

// DEV_NOTE: Money in BudgetDO is counted in whole micro-dollars (1e-6 USD, the scale of every *_usd column), so sums
// never drift the way float dollars would. numeric(12,6) tops out near 1e12 micros, well inside Number's exact range.
const MICROS_PER_USD = 1_000_000;

// USD (a numeric(12,6) string or a number) → micro-dollars, rounded up so a conversion never undercounts. Invalid or
// negative input → 0.
export function usdToMicros(usd: string | number): number {
  const value = typeof usd === "number" ? usd : Number(usd);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // DEV_NOTE: toFixed(6) first: 0.1 * 1e6 is 100000.00000000001 in floats, which ceil would turn into 100001
  return Math.ceil(Number((value * MICROS_PER_USD).toFixed(6)));
}

export function microsToUsd(micros: number): string {
  return (micros / MICROS_PER_USD).toFixed(6);
}

// DEV_NOTE: The billing period is the UTC calendar month (Settings › Budget: "Monthly, resets on the 1st"); the user
// cost cap counts per UTC day. Keys are what BudgetDO stores to tell periods and days apart.
export function budgetPeriodKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function budgetDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// First instant of the period a key names (UTC)
export function budgetPeriodStart(periodKey: string): Date {
  return new Date(`${periodKey}-01T00:00:00.000Z`);
}

// DEV_NOTE: BudgetDO storage (SQLite kv), one key each. Internal ids only; nothing here leaves the worker.
//   ledger: the company's billing period. spentMicros = settled spend (seeded from model_calls when the period
//     starts), budgetMicros = spending_budget as last read (re-read every BUDGET_REFRESH_MS), dayKey = the UTC day
//     whose user counters are live.
//   reservation: one model call's hold, until it settles or expires (BUDGET_RESERVATION_TTL_MS).
//   user: one chatbot user's cost today and the times of their messages in the last minute.
export const ZBudgetLedger = z.object({
  companyId: z.string(),
  periodKey: z.string(),
  dayKey: z.string(),
  spentMicros: z.number().int().min(0),
  budgetMicros: z.number().int().min(0),
  budgetLoadedAt: z.number().int(),
});
export type BudgetLedger = z.infer<typeof ZBudgetLedger>;

export const ZBudgetReservation = z.object({
  reservationId: z.string(),
  chatbotUserId: z.string().nullable(),
  periodKey: z.string(),
  dayKey: z.string(),
  amountMicros: z.number().int().min(0),
  createdAt: z.number().int(),
});
export type BudgetReservation = z.infer<typeof ZBudgetReservation>;

export const ZBudgetUserCounters = z.object({
  dayKey: z.string(),
  spentMicros: z.number().int().min(0),
  messageTimes: z.array(z.number().int()),
});
export type BudgetUserCounters = z.infer<typeof ZBudgetUserCounters>;
