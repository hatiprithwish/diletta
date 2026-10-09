import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import BudgetLedgerProvider from "@/providers/budgetLedger";
import TurnBudget from "@/budget/TurnBudget";
import ModelCallBudgetProvider from "@/providers/modelCallBudget";

// DEV_NOTE: Unit tests for the budget math (M2-4): BudgetDO's ledger arithmetic, the Conversation DO's turn caps and
// the sizing of one call's hold.
// No database, no Durable Object; BudgetDO itself is covered against Neon in budget.test.ts.

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

const ledger = (overrides: Partial<Schemas.BudgetLedger> = {}): Schemas.BudgetLedger => ({
  ...BudgetLedgerProvider.openPeriod({
    companyId: "1",
    now: NOW,
    budgetMicros: 1_000_000,
    spentMicros: 0,
  }),
  ...overrides,
});

const reservation = (
  overrides: Partial<Schemas.BudgetReservation> = {},
): Schemas.BudgetReservation => ({
  reservationId: crypto.randomUUID(),
  chatbotUserId: "7",
  periodKey: "2026-10",
  dayKey: "2026-10-09",
  amountMicros: 100_000,
  createdAt: NOW,
  ...overrides,
});

const user = (overrides: Partial<Schemas.BudgetUserCounters> = {}): Schemas.BudgetUserCounters => ({
  dayKey: "2026-10-09",
  spentMicros: 0,
  messageTimes: [],
  ...overrides,
});

describe("budget money and periods", () => {
  it("converts USD to whole micro-dollars without float drift, never down", () => {
    expect(Schemas.usdToMicros("0.100000")).toBe(100_000);
    expect(Schemas.usdToMicros(0.1)).toBe(100_000);
    expect(Schemas.usdToMicros("10.000000")).toBe(10_000_000);
    expect(Schemas.usdToMicros("0.0000001")).toBe(1);
    expect(Schemas.usdToMicros("-1")).toBe(0);
    expect(Schemas.usdToMicros("not a number")).toBe(0);
    expect(Schemas.microsToUsd(1_234_567)).toBe("1.234567");
  });

  it("uses the UTC calendar month as the billing period and the UTC day for user caps", () => {
    const lastInstant = Date.parse("2026-10-31T23:59:59.999Z");
    expect(Schemas.budgetPeriodKey(lastInstant)).toBe("2026-10");
    expect(Schemas.budgetPeriodKey(lastInstant + 1)).toBe("2026-11");
    expect(Schemas.budgetDayKey(lastInstant + 1)).toBe("2026-11-01");
    expect(Schemas.budgetPeriodStart("2026-11").toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("defaults an unset company budget to $10 a month", () => {
    expect(Schemas.usdToMicros(Schemas.DEFAULT_SPENDING_BUDGET_USD)).toBe(10_000_000);
  });
});

describe("BudgetLedgerProvider", () => {
  it("counts live holds against the budget, so concurrent calls can't share the last of it", () => {
    const held = [reservation({ amountMicros: 600_000 })];
    expect(
      BudgetLedgerProvider.checkReserve({
        ledger: ledger({ spentMicros: 300_000 }),
        user: null,
        reservations: held,
        chatbotUserId: null,
        userDailyCapMicros: null,
        amountMicros: 100_000,
      }),
    ).toBeNull();
    expect(
      BudgetLedgerProvider.checkReserve({
        ledger: ledger({ spentMicros: 300_000 }),
        user: null,
        reservations: held,
        chatbotUserId: null,
        userDailyCapMicros: null,
        amountMicros: 100_001,
      }),
    ).toBe(Schemas.BudgetRefusalEnum.CompanyBudget);
  });

  it("ignores holds from an earlier period", () => {
    expect(
      BudgetLedgerProvider.heldMicros(
        [reservation({ periodKey: "2026-09", amountMicros: 900_000 }), reservation()],
        ledger(),
        null,
      ),
    ).toBe(100_000);
  });

  it("refuses a call over the user's daily cap, counting that user's holds only", () => {
    const params = {
      ledger: ledger(),
      user: user({ spentMicros: 400_000 }),
      reservations: [
        reservation({ amountMicros: 100_000 }),
        reservation({ chatbotUserId: "8", amountMicros: 500_000 }),
      ],
      chatbotUserId: "7",
      userDailyCapMicros: 600_000,
    };
    expect(BudgetLedgerProvider.checkReserve({ ...params, amountMicros: 100_000 })).toBeNull();
    expect(BudgetLedgerProvider.checkReserve({ ...params, amountMicros: 100_001 })).toBe(
      Schemas.BudgetRefusalEnum.UserDailyCost,
    );
  });

  it("admits a turn only within the message rate, and counts only admitted messages", () => {
    const base = {
      ledger: ledger(),
      reservations: [],
      chatbotUserId: "7",
      userMessagesPerMinute: 2,
      userDailyCapMicros: 1_000_000,
      now: NOW,
    };
    const first = BudgetLedgerProvider.admitTurn({ ...base, user: user() });
    const second = BudgetLedgerProvider.admitTurn({ ...base, user: first.user });
    const third = BudgetLedgerProvider.admitTurn({ ...base, user: second.user });

    expect([first.refusal, second.refusal]).toEqual([null, null]);
    expect(third.refusal).toBe(Schemas.BudgetRefusalEnum.UserMessageRate);
    expect(third.user.messageTimes).toHaveLength(2);

    // DEV_NOTE: A minute later the old messages have left the window
    const later = BudgetLedgerProvider.userCounters(
      third.user,
      "2026-10-09",
      NOW + Constants.BUDGET_MESSAGE_WINDOW_MS,
    );
    expect(BudgetLedgerProvider.admitTurn({ ...base, user: later }).refusal).toBeNull();
  });

  it("refuses a turn when the company budget or the user's day is used up", () => {
    const base = {
      reservations: [],
      chatbotUserId: "7",
      userMessagesPerMinute: 10,
      userDailyCapMicros: 500_000,
      now: NOW,
    };
    expect(
      BudgetLedgerProvider.admitTurn({
        ...base,
        ledger: ledger({ spentMicros: 1_000_000 }),
        user: user(),
      }).refusal,
    ).toBe(Schemas.BudgetRefusalEnum.CompanyBudget);
    expect(
      BudgetLedgerProvider.admitTurn({
        ...base,
        ledger: ledger(),
        user: user({ spentMicros: 500_000 }),
      }).refusal,
    ).toBe(Schemas.BudgetRefusalEnum.UserDailyCost);
  });

  it("settles the real cost, or the whole hold when the cost isn't known", () => {
    const held = reservation({ amountMicros: 250_000 });
    const known = BudgetLedgerProvider.settle({
      ledger: ledger({ spentMicros: 10 }),
      user: user(),
      reservation: held,
      costMicros: 40_000,
    });
    expect(known.ledger.spentMicros).toBe(40_010);
    expect(known.user?.spentMicros).toBe(40_000);

    const unknown = BudgetLedgerProvider.settle({
      ledger: ledger(),
      user: user(),
      reservation: held,
      costMicros: null,
    });
    expect(unknown.ledger.spentMicros).toBe(250_000);
    expect(unknown.user?.spentMicros).toBe(250_000);
  });

  it("doesn't count a hold from before a rollover in the new period or day", () => {
    const settled = BudgetLedgerProvider.settle({
      ledger: ledger({ periodKey: "2026-11", dayKey: "2026-11-01" }),
      user: user({ dayKey: "2026-11-01" }),
      reservation: reservation({ periodKey: "2026-10", dayKey: "2026-10-31" }),
      costMicros: 90_000,
    });
    expect(settled.ledger.spentMicros).toBe(0);
    expect(settled.user?.spentMicros).toBe(0);
  });

  it("starts a new day's user counters at zero", () => {
    const next = BudgetLedgerProvider.userCounters(
      user({ spentMicros: 999 }),
      "2026-10-10",
      NOW + 24 * 60 * 60_000,
    );
    expect(next).toEqual({ dayKey: "2026-10-10", spentMicros: 0, messageTimes: [] });
  });

  it("expires a hold never settled after its time to live", () => {
    const fresh = reservation({ createdAt: NOW - Constants.BUDGET_RESERVATION_TTL_MS + 1 });
    const stale = reservation({ createdAt: NOW - Constants.BUDGET_RESERVATION_TTL_MS });
    const { live, expired } = BudgetLedgerProvider.splitExpired([fresh, stale], NOW);
    expect(live).toEqual([fresh]);
    expect(expired).toEqual([stale]);
  });

  it("keeps the expiry longer than the longest allowed turn", () => {
    expect(Constants.BUDGET_RESERVATION_TTL_MS).toBeGreaterThan(900 * 1000);
  });
});

describe("TurnBudget", () => {
  const limits = (overrides: Partial<Schemas.ConfigSpec["limits"]> = {}) => ({
    ...Schemas.CONFIG_SPEC_PLATFORM_DEFAULTS.limits,
    maxTokensPerTurn: 1_000,
    turnCostCapUsd: 0.5,
    conversationCostCapUsd: 1,
    ...overrides,
  });

  function turnBudget(overrides: Partial<Schemas.ConfigSpec["limits"]> = {}, spent = 0) {
    let conversationSpentMicros = spent;
    const caps = new TurnBudget({
      limits: limits(overrides),
      getConversationSpentMicros: () => conversationSpentMicros,
      onSpent: (costMicros: number) => {
        conversationSpentMicros += costMicros;
      },
    });
    return { caps, conversationSpent: () => conversationSpentMicros };
  }

  it("counts only output tokens against maxTokensPerTurn", () => {
    const { caps } = turnBudget();
    expect(caps.remaining().outputTokens).toBe(1_000);
    expect(caps.reserve({ amountMicros: 1, outputTokens: 900 })).toBeNull();
    expect(caps.remaining().outputTokens).toBe(100);
    caps.settle({ amountMicros: 1, outputTokens: 900, costMicros: 1, usedOutputTokens: 300 });
    expect(caps.remaining().outputTokens).toBe(700);
  });

  it("gives the cost left as the smaller of the turn's and the conversation's, naming which", () => {
    expect(turnBudget().caps.remaining()).toMatchObject({
      costMicros: 500_000,
      costRefusal: Schemas.BudgetRefusalEnum.TurnCost,
    });
    expect(turnBudget({}, 900_000).caps.remaining()).toMatchObject({
      costMicros: 100_000,
      costRefusal: Schemas.BudgetRefusalEnum.ConversationCost,
    });
  });

  it("refuses a hold over the turn's tokens, the turn's cost or the conversation's cost", () => {
    expect(turnBudget().caps.reserve({ amountMicros: 1, outputTokens: 1_001 })).toBe(
      Schemas.BudgetRefusalEnum.TurnTokens,
    );
    expect(turnBudget().caps.reserve({ amountMicros: 500_001, outputTokens: 1 })).toBe(
      Schemas.BudgetRefusalEnum.TurnCost,
    );
    expect(turnBudget({}, 900_000).caps.reserve({ amountMicros: 100_001, outputTokens: 1 })).toBe(
      Schemas.BudgetRefusalEnum.ConversationCost,
    );
  });

  it("moves a settled call's cost into the conversation's spend and frees its hold", () => {
    const { caps, conversationSpent } = turnBudget();
    expect(caps.reserve({ amountMicros: 400_000, outputTokens: 800 })).toBeNull();
    caps.settle({
      amountMicros: 400_000,
      outputTokens: 800,
      costMicros: 30_000,
      usedOutputTokens: 200,
    });

    expect(conversationSpent()).toBe(30_000);
    expect(caps.reserve({ amountMicros: 470_000, outputTokens: 800 })).toBeNull();
    expect(caps.isExhausted()).toBe(false);
  });

  it("is exhausted once the turn's output tokens are used up", () => {
    const { caps } = turnBudget();
    caps.reserve({ amountMicros: 1, outputTokens: 1_000 });
    caps.settle({ amountMicros: 1, outputTokens: 1_000, costMicros: 1, usedOutputTokens: 1_000 });
    expect(caps.isExhausted()).toBe(true);
  });

  it("passes the user's daily cap on to BudgetDO", () => {
    expect(turnBudget({ userDailyCostCapUsd: 3 }).caps.userDailyCostCapUsd).toBe(3);
  });
});

describe("ModelCallBudgetProvider.size", () => {
  const fable = Schemas.getModelPrice(Schemas.ModelProviderEnum.Anthropic, "claude-fable-5-1");
  const sonnet = Schemas.getModelPrice(Schemas.ModelProviderEnum.Anthropic, "claude-sonnet-5-5");
  const defaults = Schemas.CONFIG_SPEC_PLATFORM_DEFAULTS.limits;
  const fresh = (overrides: Partial<ReturnType<Schemas.ModelCallCaps["remaining"]>> = {}) => ({
    outputTokens: defaults.maxTokensPerTurn,
    costMicros: Schemas.usdToMicros(defaults.turnCostCapUsd),
    costRefusal: Schemas.BudgetRefusalEnum.TurnCost,
    ...overrides,
  });

  it("prices input at the plain input rate and the full output asked for", () => {
    if (!sonnet) throw new Error("No price");
    const sized = ModelCallBudgetProvider.size({
      price: sonnet,
      estimate: { inputTokens: 1_000, requestedMaxOutputTokens: 8_192 },
      remaining: null,
    });
    // DEV_NOTE: $2/M × 1,000 + $10/M × 8,192 = $0.08392
    expect(sized).toEqual({ isSuccess: true, amountMicros: 83_920, maxOutputTokens: 8_192 });
  });

  it("gives a pricey model a shorter answer under the default caps instead of refusing a long prompt", () => {
    if (!fable) throw new Error("No price");
    // DEV_NOTE: ~60k characters of prompt, well past the ~22k where cache-write pricing + a fixed 8,192 output
    // refused every turn: $10/M × 20,000 = $0.20 in, so $0.30 left buys 5,999 output tokens at $50/M
    const sized = ModelCallBudgetProvider.size({
      price: fable,
      estimate: { inputTokens: 20_000, requestedMaxOutputTokens: 8_192 },
      remaining: fresh(),
    });
    if (!sized.isSuccess) throw new Error(`Refused: ${sized.refusal}`);
    expect(sized.maxOutputTokens).toBe(5_999);
    expect(sized.amountMicros).toBeLessThanOrEqual(fresh().costMicros);
  });

  it("caps the output at the turn's output tokens left", () => {
    if (!sonnet) throw new Error("No price");
    const sized = ModelCallBudgetProvider.size({
      price: sonnet,
      estimate: { inputTokens: 100, requestedMaxOutputTokens: 8_192 },
      remaining: fresh({ outputTokens: 1_200 }),
    });
    expect(sized).toMatchObject({ isSuccess: true, maxOutputTokens: 1_200 });
  });

  it("refuses when fewer than the minimum output tokens are left, naming the cap that ran out", () => {
    if (!sonnet || !fable) throw new Error("No price");
    expect(
      ModelCallBudgetProvider.size({
        price: sonnet,
        estimate: { inputTokens: 100, requestedMaxOutputTokens: 8_192 },
        remaining: fresh({ outputTokens: Constants.MODEL_CALL_MIN_OUTPUT_TOKENS - 1 }),
      }),
    ).toEqual({ isSuccess: false, refusal: Schemas.BudgetRefusalEnum.TurnTokens });
    expect(
      ModelCallBudgetProvider.size({
        price: fable,
        estimate: { inputTokens: 1_000, requestedMaxOutputTokens: 8_192 },
        remaining: fresh({
          costMicros: 20_000,
          costRefusal: Schemas.BudgetRefusalEnum.ConversationCost,
        }),
      }),
    ).toEqual({ isSuccess: false, refusal: Schemas.BudgetRefusalEnum.ConversationCost });
  });

  it("allows a call that asks for less than the minimum itself", () => {
    if (!sonnet) throw new Error("No price");
    expect(
      ModelCallBudgetProvider.size({
        price: sonnet,
        estimate: { inputTokens: 100, requestedMaxOutputTokens: 50 },
        remaining: fresh(),
      }),
    ).toMatchObject({ isSuccess: true, maxOutputTokens: 50 });
  });

  it("uses the long-context prices past their line", () => {
    const price: Schemas.ModelPrice = {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 1,
      cacheReadUsdPerMTok: 1,
      cacheWriteUsdPerMTok: 1,
      longContext: {
        overInputTokens: 1_000,
        inputUsdPerMTok: 2,
        outputUsdPerMTok: 100,
        cacheReadUsdPerMTok: 2,
        cacheWriteUsdPerMTok: 2,
      },
    };
    const sized = ModelCallBudgetProvider.size({
      price,
      estimate: { inputTokens: 2_000, requestedMaxOutputTokens: 8_192 },
      remaining: fresh({ costMicros: 104_000 }),
    });
    // DEV_NOTE: input 2,000 × 2 = 4,000 micros; (104,000 - 4,000 - 1) / 100 per output token → 999
    expect(sized).toMatchObject({ isSuccess: true, maxOutputTokens: 999 });
  });
});
