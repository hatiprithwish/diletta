import Constants from "@/config/Constants";
import * as Schemas from "@app/schemas";

// DEV_NOTE: BudgetDO's arithmetic (M2-4), pure so it is unit-tested on its own; BudgetDO does the storage and the seed.
// All money is whole micro-dollars. What counts against a limit is spent + held: settled spend plus every live
// reservation, so concurrent calls can't each see room the others are about to use.
//   - company: per billing period (UTC month), against spending_budget. A reservation counts only in its own period.
//   - chatbot user: per UTC day, against userDailyCostCapUsd; messages per minute against userMessagesPerMinute.
//   - a reservation never settled is counted as spent at its full amount once it expires (never free).
export default class BudgetLedgerProvider {
  // DEV_NOTE: The ledger for a new billing period, seeded with what model_calls already holds for it
  static openPeriod(params: {
    companyId: string;
    now: number;
    budgetMicros: number;
    spentMicros: number;
  }): Schemas.BudgetLedger {
    return {
      companyId: params.companyId,
      periodKey: Schemas.budgetPeriodKey(params.now),
      dayKey: Schemas.budgetDayKey(params.now),
      spentMicros: params.spentMicros,
      budgetMicros: params.budgetMicros,
      budgetLoadedAt: params.now,
    };
  }

  // DEV_NOTE: A user's counters for the given day: a new day starts at 0 spend; message times older than the window
  // are dropped either way
  static userCounters(
    stored: Schemas.BudgetUserCounters | undefined,
    dayKey: string,
    now: number,
  ): Schemas.BudgetUserCounters {
    const messageTimes = (stored?.messageTimes ?? []).filter(
      (time) => now - time < Constants.BUDGET_MESSAGE_WINDOW_MS,
    );
    if (!stored || stored.dayKey !== dayKey) {
      return { dayKey, spentMicros: 0, messageTimes };
    }
    return { ...stored, messageTimes };
  }

  static splitExpired(
    reservations: Schemas.BudgetReservation[],
    now: number,
  ): { live: Schemas.BudgetReservation[]; expired: Schemas.BudgetReservation[] } {
    const live: Schemas.BudgetReservation[] = [];
    const expired: Schemas.BudgetReservation[] = [];
    for (const reservation of reservations) {
      if (now - reservation.createdAt >= Constants.BUDGET_RESERVATION_TTL_MS) {
        expired.push(reservation);
      } else {
        live.push(reservation);
      }
    }
    return { live, expired };
  }

  // DEV_NOTE: Held for the company in the ledger's period, or for one user on the ledger's day
  static heldMicros(
    reservations: Schemas.BudgetReservation[],
    ledger: Schemas.BudgetLedger,
    chatbotUserId: string | null,
  ): number {
    return reservations
      .filter((reservation) =>
        chatbotUserId === null
          ? reservation.periodKey === ledger.periodKey
          : reservation.chatbotUserId === chatbotUserId && reservation.dayKey === ledger.dayKey,
      )
      .reduce((total, reservation) => total + reservation.amountMicros, 0);
  }

  // DEV_NOTE: A new turn: refused when the user is over their message rate, or when the company budget or the user's
  // daily cap has no room left at all. An admitted message is added to the user's message times (a refused one isn't,
  // so waiting always lets the user back in).
  static admitTurn(params: {
    ledger: Schemas.BudgetLedger;
    user: Schemas.BudgetUserCounters;
    reservations: Schemas.BudgetReservation[];
    chatbotUserId: string;
    userMessagesPerMinute: number;
    userDailyCapMicros: number;
    now: number;
  }): { refusal: Schemas.BudgetRefusalEnum | null; user: Schemas.BudgetUserCounters } {
    const { ledger, user, reservations } = params;
    if (user.messageTimes.length >= params.userMessagesPerMinute) {
      return { refusal: Schemas.BudgetRefusalEnum.UserMessageRate, user };
    }
    const companyUsed = ledger.spentMicros + this.heldMicros(reservations, ledger, null);
    if (companyUsed >= ledger.budgetMicros) {
      return { refusal: Schemas.BudgetRefusalEnum.CompanyBudget, user };
    }
    const userUsed = user.spentMicros + this.heldMicros(reservations, ledger, params.chatbotUserId);
    if (userUsed >= params.userDailyCapMicros) {
      return { refusal: Schemas.BudgetRefusalEnum.UserDailyCost, user };
    }
    return { refusal: null, user: { ...user, messageTimes: [...user.messageTimes, params.now] } };
  }

  // DEV_NOTE: One call's worst case must fit in what is left: the company budget, and the user's daily cap when the
  // call has a user. user and userDailyCapMicros are null for a call without one.
  static checkReserve(params: {
    ledger: Schemas.BudgetLedger;
    user: Schemas.BudgetUserCounters | null;
    reservations: Schemas.BudgetReservation[];
    chatbotUserId: string | null;
    userDailyCapMicros: number | null;
    amountMicros: number;
  }): Schemas.BudgetRefusalEnum | null {
    const { ledger, user, reservations, amountMicros } = params;
    const companyUsed = ledger.spentMicros + this.heldMicros(reservations, ledger, null);
    if (companyUsed + amountMicros > ledger.budgetMicros) {
      return Schemas.BudgetRefusalEnum.CompanyBudget;
    }
    if (user && params.chatbotUserId !== null && params.userDailyCapMicros !== null) {
      const userUsed =
        user.spentMicros + this.heldMicros(reservations, ledger, params.chatbotUserId);
      if (userUsed + amountMicros > params.userDailyCapMicros) {
        return Schemas.BudgetRefusalEnum.UserDailyCost;
      }
    }
    return null;
  }

  // DEV_NOTE: What a settled (or expired) reservation adds: its real cost, or the whole hold when the cost isn't known
  // (Pending / Unknown, or never settled). It counts only in the period and day it was made in: one made before a
  // rollover belongs to a period whose counters are gone.
  static settle(params: {
    ledger: Schemas.BudgetLedger;
    user: Schemas.BudgetUserCounters | null;
    reservation: Schemas.BudgetReservation;
    costMicros: number | null;
  }): { ledger: Schemas.BudgetLedger; user: Schemas.BudgetUserCounters | null } {
    const { ledger, user, reservation } = params;
    const charged = params.costMicros ?? reservation.amountMicros;
    return {
      ledger:
        reservation.periodKey === ledger.periodKey
          ? { ...ledger, spentMicros: ledger.spentMicros + charged }
          : ledger,
      user:
        user && reservation.dayKey === user.dayKey
          ? { ...user, spentMicros: user.spentMicros + charged }
          : user,
    };
  }
}
