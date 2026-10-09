import { DurableObject } from "cloudflare:workers";
import Constants from "@/config/Constants";
import BudgetLedgerProvider from "@/providers/budgetLedger";
import AppLogger from "@/providers/logger";
import BudgetRepo from "@/repositories/BudgetRepo";
import * as Schemas from "@app/schemas";

const LEDGER_KEY = "ledger";
const RESERVATION_PREFIX = "reservation:";
const USER_PREFIX = "user:";

// DEV_NOTE: BudgetDO (M2-4): one per company, named by companies.id (internal; reached only from the worker and the
// Conversation DO, never routed publicly). The live counters behind every model call's budget check:
//   - admitTurn: before a turn (Conversation DO): user message rate, and room left in the company budget and the
//     user's daily cap.
//   - reserve: before every provider call (ModelRouterRepo, through the recording middleware): the call's worst-case
//     cost is held, or the call is refused and never reaches the provider.
//   - settle: after the call: the hold is replaced by the real cost (or kept whole when the cost isn't known yet).
// Plain DurableObject (no Think/Agents: no sockets, no chat), state in its SQLite kv, synchronous between awaits. The
// only await is the Neon read (BudgetRepo): the budget, re-read every BUDGET_REFRESH_MS, and when a period starts (or
// on first use) the period's spend so far from model_calls. Every check and write after it runs with no await in
// between, so concurrent calls can't both take the last of the budget. Fails closed: no ledger for the current period
// (Neon unreachable) refuses with Unavailable. A stale budget (a refresh failed) is kept until the next refresh.
export class BudgetDO extends DurableObject<Env> {
  private loading: Promise<void> | null = null;

  async admitTurn(
    request: Schemas.AdmitBudgetTurnRequest,
  ): Promise<Schemas.BudgetAdmissionResponse> {
    if (!(await this.ensureLedger(request.companyId))) {
      return this.refuse(
        Schemas.LogAction.AdmitBudgetTurn,
        Schemas.BudgetRefusalEnum.Unavailable,
        request,
      );
    }

    const now = Date.now();
    const ledger = this.getLedger();
    if (!ledger) {
      return this.refuse(
        Schemas.LogAction.AdmitBudgetTurn,
        Schemas.BudgetRefusalEnum.Unavailable,
        request,
      );
    }
    const reservations = this.liveReservations(now);
    const user = BudgetLedgerProvider.userCounters(
      this.getUser(request.chatbotUserId),
      ledger.dayKey,
      now,
    );
    const admitted = BudgetLedgerProvider.admitTurn({
      ledger,
      user,
      reservations,
      chatbotUserId: request.chatbotUserId,
      userMessagesPerMinute: request.userMessagesPerMinute,
      userDailyCapMicros: Schemas.usdToMicros(request.userDailyCostCapUsd),
      now,
    });
    this.putUser(request.chatbotUserId, admitted.user);
    if (admitted.refusal) {
      return this.refuse(Schemas.LogAction.AdmitBudgetTurn, admitted.refusal, request);
    }
    return { isSuccess: true, message: "Turn admitted" };
  }

  async reserve(request: Schemas.ReserveBudgetRequest): Promise<Schemas.BudgetReservationResponse> {
    if (!(await this.ensureLedger(request.companyId))) {
      return this.refuse(
        Schemas.LogAction.ReserveBudget,
        Schemas.BudgetRefusalEnum.Unavailable,
        request,
      );
    }

    const now = Date.now();
    const ledger = this.getLedger();
    if (!ledger) {
      return this.refuse(
        Schemas.LogAction.ReserveBudget,
        Schemas.BudgetRefusalEnum.Unavailable,
        request,
      );
    }
    const reservations = this.liveReservations(now);
    const user =
      request.chatbotUserId === null
        ? null
        : BudgetLedgerProvider.userCounters(
            this.getUser(request.chatbotUserId),
            ledger.dayKey,
            now,
          );
    const refusal = BudgetLedgerProvider.checkReserve({
      ledger,
      user,
      reservations,
      chatbotUserId: request.chatbotUserId,
      userDailyCapMicros:
        request.userDailyCostCapUsd === null
          ? null
          : Schemas.usdToMicros(request.userDailyCostCapUsd),
      amountMicros: request.amountMicros,
    });
    if (refusal) {
      return this.refuse(Schemas.LogAction.ReserveBudget, refusal, request);
    }

    const reservationId = crypto.randomUUID();
    const reservation: Schemas.BudgetReservation = {
      reservationId,
      chatbotUserId: request.chatbotUserId,
      periodKey: ledger.periodKey,
      dayKey: ledger.dayKey,
      amountMicros: request.amountMicros,
      createdAt: now,
    };
    this.ctx.storage.kv.put(`${RESERVATION_PREFIX}${reservationId}`, reservation);
    return { isSuccess: true, message: "Budget reserved", reservationId };
  }

  // DEV_NOTE: No Neon read: a settle only moves a hold into spend. An unknown id (already expired and counted, or
  // settled twice) is a no-op success.
  async settle(request: Schemas.SettleBudgetRequest): Promise<Schemas.ApiResponse> {
    const ledger = this.getLedger();
    if (!ledger || ledger.companyId !== request.companyId) {
      AppLogger.error({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.SettleBudget,
        message: "No ledger for this company; settle dropped",
        metadata: { companyId: request.companyId, reservationId: request.reservationId },
      });
      return { isSuccess: false, message: "No ledger for this company" };
    }
    const key = `${RESERVATION_PREFIX}${request.reservationId}`;
    const reservation = this.parseReservation(this.ctx.storage.kv.get(key));
    if (!reservation) {
      return { isSuccess: true, message: "Reservation already settled" };
    }
    this.applySettle(ledger, reservation, request.costMicros, Date.now());
    this.ctx.storage.kv.delete(key);
    return { isSuccess: true, message: "Budget settled" };
  }

  // DEV_NOTE: true when there is a ledger for this company and the current period. Loads it (one load at a time; a
  // caller arriving meanwhile waits for the same one) when the period changed, the DO is new, or the budget is due for
  // a refresh. A failed refresh keeps the current period's ledger as it was.
  private async ensureLedger(companyId: string): Promise<boolean> {
    const stored = this.getLedger();
    if (stored && stored.companyId !== companyId) {
      AppLogger.error({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.LoadBudgetLedger,
        message: "BudgetDO asked for another company",
        metadata: { companyId, ledgerCompanyId: stored.companyId },
      });
      return false;
    }

    const now = Date.now();
    const isCurrent = stored?.periodKey === Schemas.budgetPeriodKey(now);
    const isFresh = isCurrent && now - (stored?.budgetLoadedAt ?? 0) < Constants.BUDGET_REFRESH_MS;
    if (!isFresh) {
      this.loading ??= this.loadLedger(companyId).finally(() => {
        this.loading = null;
      });
      await this.loading;
    }

    const ledger = this.getLedger();
    if (!ledger || ledger.periodKey !== Schemas.budgetPeriodKey(Date.now())) {
      return false;
    }
    this.rollDay(ledger, Date.now());
    return true;
  }

  // DEV_NOTE: Reads the budget, and the period's spend so far when the ledger is for an older period (or missing).
  // Judged again after the read: a rollover between the two is caught by the caller's check.
  private async loadLedger(companyId: string): Promise<void> {
    const startedAt = Date.now();
    const periodKey = Schemas.budgetPeriodKey(startedAt);
    const isSpendNeeded = this.getLedger()?.periodKey !== periodKey;
    const seed = await new BudgetRepo(this.env).getBudgetSeed({
      companyId,
      periodStart: Schemas.budgetPeriodStart(periodKey),
      isSpendNeeded,
    });
    if (!seed.isSuccess || seed.spendingBudgetUsd === undefined) {
      return;
    }

    const budgetMicros = Schemas.usdToMicros(seed.spendingBudgetUsd);
    const current = this.getLedger();
    if (isSpendNeeded || !current || current.periodKey !== periodKey) {
      if (seed.spentUsd === undefined) return;
      const opened = BudgetLedgerProvider.openPeriod({
        companyId,
        now: startedAt,
        budgetMicros,
        spentMicros: Schemas.usdToMicros(seed.spentUsd),
      });
      this.pruneUsers(opened.dayKey);
      this.putLedger(opened);
      return;
    }
    this.putLedger({ ...current, budgetMicros, budgetLoadedAt: startedAt });
  }

  // DEV_NOTE: A new UTC day: the users' counters from earlier days are dropped
  private rollDay(ledger: Schemas.BudgetLedger, now: number): void {
    const dayKey = Schemas.budgetDayKey(now);
    if (ledger.dayKey === dayKey) return;
    this.pruneUsers(dayKey);
    this.putLedger({ ...ledger, dayKey });
  }

  private pruneUsers(dayKey: string): void {
    for (const [key, value] of this.ctx.storage.kv.list({ prefix: USER_PREFIX })) {
      const user = Schemas.ZBudgetUserCounters.safeParse(value);
      if (!user.success || user.data.dayKey !== dayKey) {
        this.ctx.storage.kv.delete(key);
      }
    }
  }

  // DEV_NOTE: Every stored reservation, with the expired ones counted as spent (at their full amount) and removed
  private liveReservations(now: number): Schemas.BudgetReservation[] {
    const stored: Schemas.BudgetReservation[] = [];
    for (const [, value] of this.ctx.storage.kv.list({ prefix: RESERVATION_PREFIX })) {
      const reservation = this.parseReservation(value);
      if (reservation) stored.push(reservation);
    }
    const { live, expired } = BudgetLedgerProvider.splitExpired(stored, now);
    for (const reservation of expired) {
      AppLogger.warn({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.ExpireBudgetReservation,
        message: "Reservation never settled; counted as spent in full",
        metadata: {
          companyId: this.getLedger()?.companyId ?? null,
          reservationId: reservation.reservationId,
          amountMicros: reservation.amountMicros,
        },
      });
      const ledger = this.getLedger();
      if (ledger) this.applySettle(ledger, reservation, null, now);
      this.ctx.storage.kv.delete(`${RESERVATION_PREFIX}${reservation.reservationId}`);
    }
    return live;
  }

  private applySettle(
    ledger: Schemas.BudgetLedger,
    reservation: Schemas.BudgetReservation,
    costMicros: number | null,
    now: number,
  ): void {
    const user =
      reservation.chatbotUserId === null
        ? null
        : BudgetLedgerProvider.userCounters(
            this.getUser(reservation.chatbotUserId),
            ledger.dayKey,
            now,
          );
    const settled = BudgetLedgerProvider.settle({ ledger, user, reservation, costMicros });
    this.putLedger(settled.ledger);
    if (reservation.chatbotUserId !== null && settled.user) {
      this.putUser(reservation.chatbotUserId, settled.user);
    }
  }

  private refuse(
    action: Schemas.LogAction,
    refusal: Schemas.BudgetRefusalEnum,
    request: { companyId: string; chatbotUserId: string | null },
  ): { isSuccess: false; message: string; refusal: Schemas.BudgetRefusalEnum } {
    const entry = {
      category: Schemas.LogCategory.Budget,
      action,
      message: "Budget refused",
      metadata: { companyId: request.companyId, chatbotUserId: request.chatbotUserId, refusal },
    };
    // DEV_NOTE: A limit doing its job is a warning; not being able to count at all is an error
    if (refusal === Schemas.BudgetRefusalEnum.Unavailable) {
      AppLogger.error(entry);
    } else {
      AppLogger.warn(entry);
    }
    return { isSuccess: false, message: "Budget refused", refusal };
  }

  private getLedger(): Schemas.BudgetLedger | null {
    const parsed = Schemas.ZBudgetLedger.safeParse(this.ctx.storage.kv.get(LEDGER_KEY));
    return parsed.success ? parsed.data : null;
  }

  private putLedger(ledger: Schemas.BudgetLedger): void {
    this.ctx.storage.kv.put(LEDGER_KEY, ledger);
  }

  private getUser(chatbotUserId: string): Schemas.BudgetUserCounters | undefined {
    const parsed = Schemas.ZBudgetUserCounters.safeParse(
      this.ctx.storage.kv.get(`${USER_PREFIX}${chatbotUserId}`),
    );
    return parsed.success ? parsed.data : undefined;
  }

  private putUser(chatbotUserId: string, user: Schemas.BudgetUserCounters): void {
    this.ctx.storage.kv.put(`${USER_PREFIX}${chatbotUserId}`, user);
  }

  private parseReservation(value: unknown): Schemas.BudgetReservation | null {
    const parsed = Schemas.ZBudgetReservation.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
}
