import z from "zod";
import type { BudgetRefusalEnum } from "./BudgetCommon";

// DEV_NOTE: Server-side only (BudgetDO RPC): never crosses an API, hence no "Api" in the file name. Every id is
// internal and comes from the verified session or the eval run, never from a client. Zod because BudgetDO is a trust
// boundary: it parses every request before acting on it, so a bad amount can't be stored as a hold that never counts.
const ZInternalId = z.string().regex(/^\d+$/);
const ZMicros = z.number().int().min(0);
const ZCapUsd = z.number().positive().finite();

// DEV_NOTE: Before a turn is admitted (Conversation DO, after its model is routed): counts the user's message against
// userMessagesPerMinute and checks the company budget and the user's daily cap still have room
export const ZAdmitBudgetTurnRequest = z.object({
  companyId: ZInternalId,
  chatbotUserId: ZInternalId,
  userMessagesPerMinute: z.number().int().min(1),
  userDailyCostCapUsd: ZCapUsd,
});
export type AdmitBudgetTurnRequest = z.infer<typeof ZAdmitBudgetTurnRequest>;

// DEV_NOTE: Before one provider call (ModelCallBudgetProvider): holds amountMicros (the call's worst-case cost)
// against the company budget and, when the call has a chatbot user, their daily cap. chatbotUserId /
// userDailyCostCapUsd are null for a call with no chatbot user (an eval or background job).
export const ZReserveBudgetRequest = z.object({
  companyId: ZInternalId,
  chatbotUserId: ZInternalId.nullable(),
  userDailyCostCapUsd: ZCapUsd.nullable(),
  amountMicros: ZMicros,
});
export type ReserveBudgetRequest = z.infer<typeof ZReserveBudgetRequest>;

// DEV_NOTE: After the call: costMicros is what it cost, or null when its usage isn't known yet (Pending / Unknown),
// in which case the whole reservation is kept as spend: a call that may have been billed is never free.
export const ZSettleBudgetRequest = z.object({
  companyId: ZInternalId,
  reservationId: z.uuid(),
  costMicros: ZMicros.nullable(),
});
export type SettleBudgetRequest = z.infer<typeof ZSettleBudgetRequest>;

// DEV_NOTE: Server-side only (BudgetDO → BudgetRepo): the company's budget, and when isSpendNeeded (a new period, or
// the DO's first use) what model_calls already holds for the period since periodStart
export interface GetBudgetSeedRequest {
  companyId: string;
  periodStart: Date;
  isSpendNeeded: boolean;
}

// DEV_NOTE: Server-side only — one provider call as the recording middleware sizes it, once per call (retries reuse
// it): the prompt's estimated tokens and the most output the caller asked for (already within the platform cap)
export interface ModelCallEstimate {
  inputTokens: number;
  requestedMaxOutputTokens: number;
}

// DEV_NOTE: Server-side only — the caller's own caps on top of the company budget: the Conversation DO's turn and
// conversation limits (TurnBudget). A type-only contract (no runtime code), kept here like every other type.
// Synchronous: the counters live in the caller's memory.
//   remaining: what the next call may still use — output tokens (maxTokensPerTurn counts output only) and cost in
//     micro-dollars, with the refusal to give when the cost is what runs out (TurnCost or ConversationCost).
//   reserve: holds a call's cost and output tokens, or says why not.
//   settle: releases the hold and counts what the call used (cost = the hold when its usage isn't known).
export interface ModelCallCaps {
  userDailyCostCapUsd: number | null;
  remaining(): { outputTokens: number; costMicros: number; costRefusal: BudgetRefusalEnum };
  reserve(hold: { amountMicros: number; outputTokens: number }): BudgetRefusalEnum | null;
  settle(params: {
    amountMicros: number;
    outputTokens: number;
    costMicros: number;
    usedOutputTokens: number;
  }): void;
}
