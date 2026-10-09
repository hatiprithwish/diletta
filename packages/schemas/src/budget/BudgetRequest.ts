import type { BudgetRefusalEnum } from "./BudgetCommon";

// DEV_NOTE: Server-side only (BudgetDO RPC): never crosses an API, hence no "Api" in the file name. Every id is
// internal and comes from the verified session or the eval run, never from a client.

// DEV_NOTE: Before a turn is admitted (Conversation DO): counts the user's message against userMessagesPerMinute and
// checks the company budget and the user's daily cap still have room
export interface AdmitBudgetTurnRequest {
  companyId: string;
  chatbotUserId: string;
  userMessagesPerMinute: number;
  userDailyCostCapUsd: number;
}

// DEV_NOTE: Before one provider call (the router): holds amountMicros (the call's worst-case cost) against the company
// budget and, when the call has a chatbot user, their daily cap. chatbotUserId / userDailyCostCapUsd are null for a
// call with no chatbot user (an eval or background job).
export interface ReserveBudgetRequest {
  companyId: string;
  chatbotUserId: string | null;
  userDailyCostCapUsd: number | null;
  amountMicros: number;
}

// DEV_NOTE: After the call: costMicros is what it cost, or null when its usage isn't known yet (Pending / Unknown),
// in which case the whole reservation is kept as spend: a call that may have been billed is never free.
export interface SettleBudgetRequest {
  companyId: string;
  reservationId: string;
  costMicros: number | null;
}

// DEV_NOTE: Server-side only (BudgetDO → BudgetRepo): the company's budget, and when isSpendNeeded (a new period, or
// the DO's first use) what model_calls already holds for the period since periodStart
export interface GetBudgetSeedRequest {
  companyId: string;
  periodStart: Date;
  isSpendNeeded: boolean;
}

// DEV_NOTE: Server-side only — one provider call's worst case, as the recording middleware sizes it
export interface ModelCallEstimate {
  inputTokens: number;
  maxOutputTokens: number;
}

// DEV_NOTE: Server-side only — the caller's own caps on top of the company budget (the Conversation DO's turn and
// conversation limits, TurnBudgetProvider). Synchronous: they live in the caller's memory. reserve holds amountMicros
// and tokens or says why not; settle releases the hold and counts what the call really used (cost and tokens equal
// the hold when its usage isn't known). userDailyCostCapUsd is passed on to BudgetDO.
export interface ModelCallCaps {
  userDailyCostCapUsd: number | null;
  maxOutputTokens(estimatedInputTokens: number): number;
  reserve(params: { amountMicros: number; tokens: number }): BudgetRefusalEnum | null;
  settle(params: {
    amountMicros: number;
    tokens: number;
    costMicros: number;
    usedTokens: number;
  }): void;
}
