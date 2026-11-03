import { DurableObject } from "cloudflare:workers";
import Constants from "@/config/Constants";
import BudgetLedgerProvider from "@/providers/budgetLedger";
import AppLogger from "@/providers/logger";
import BudgetRepo from "@/repositories/BudgetRepo";
import * as Schemas from "@app/schemas";

const LEDGER_KEY = "ledger";
const RESERVATION_PREFIX = "reservation:";
const USER_PREFIX = "user:";
// DEV_NOTE: The budget alerts already sent this period (M6-6): `alerted:<periodKey>:<50|80|100|exhausted>`
const ALERT_PREFIX = "alerted:";
const EXHAUSTED_ALERT = "exhausted";

// DEV_NOTE: BudgetDO (M2-4): one per company, named by companies.id (internal; reached only from the worker and the
// Conversation DO through BudgetDO.forCompany, never routed publicly). The live counters behind every model call:
//   - admitTurn: before a turn (Conversation DO): user message rate, and room left in the company budget and the
//     user's daily cap.
//   - reserve: before every provider call (ModelCallBudgetProvider): the call's worst-case cost is held, or the call
//     is refused and never reaches the provider.
//   - settle: after the call: the hold is replaced by the real cost (or kept whole when the cost isn't known yet).
// Plain DurableObject (no Think/Agents: no sockets, no chat), state in its SQLite kv, synchronous between awaits. Every
// request is parsed first (this is a trust boundary). The only await is the Neon read (BudgetRepo): the budget, re-read
// every BUDGET_REFRESH_MS, and when a period starts (or on first use) the period's spend so far from model_calls. After
// it, expired holds are charged and then the ledger is read, checked and written with no await in between, so
// concurrent calls can't both take the last of the budget. Fails closed: no ledger for the current period (Neon
// unreachable) refuses with Unavailable. A failed load isn't retried for BUDGET_LOAD_RETRY_MS (a stale budget is kept
// meanwhile), so an outage doesn't add a Neon timeout to every call.
//
// Timings (M6-5, the load test): each admitTurn / reserve / settle is timed from its start to its answer, and the last
// BUDGET_TIMING_MAX_SAMPLES of each are kept in memory (getTimings, resetTimings; lost when the DO is evicted, which
// getTimings shows as a later timingsSince). Workers' clock moves only at I/O, so a call that never waits (a ledger
// already loaded) counts 0 ms and one that waits for Neon counts the wait: the time that varies under load.
//
// Alerts (M6-6, our team only): each ledger write checks which of BUDGET_ALERT_THRESHOLD_PERCENTS the period's settled
// spend has reached, and a company-budget refusal counts as used up; each logs one error per company per period
// (→ Sentry → the team channel), remembered in kv so an evicted DO doesn't send it again. A new period's ledger
// drops the old period's marks.
export class BudgetDO extends DurableObject<Env> {
  private loading: Promise<void> | null = null;
  private lastFailedLoadAt = 0;
  private samples: Record<Schemas.BudgetTimedOperationEnum, number[]> = BudgetDO.emptySamples();
  private timingsSince = Date.now();

  // DEV_NOTE: The only way to reach a company's BudgetDO, so the naming rule lives in one place
  static forCompany(env: Env, companyId: string): DurableObjectStub<BudgetDO> {
    return env.BUDGET_DO.getByName(companyId);
  }

  async admitTurn(raw: Schemas.AdmitBudgetTurnRequest): Promise<Schemas.BudgetAdmissionResponse> {
    return await this.timed(Schemas.BudgetTimedOperationEnum.AdmitTurn, () =>
      this.runAdmitTurn(raw),
    );
  }

  async reserve(raw: Schemas.ReserveBudgetRequest): Promise<Schemas.BudgetReservationResponse> {
    return await this.timed(Schemas.BudgetTimedOperationEnum.Reserve, () => this.runReserve(raw));
  }

  async settle(raw: Schemas.SettleBudgetRequest): Promise<Schemas.ApiResponse> {
    return await this.timed(Schemas.BudgetTimedOperationEnum.Settle, () => this.runSettle(raw));
  }

  // DEV_NOTE: The ledger as it stands, for the load test (M6-5): the same opening as a reserve (loaded when due,
  // expired holds charged first), then nothing written
  async getSnapshot(
    raw: Schemas.GetBudgetSnapshotRequest,
  ): Promise<Schemas.BudgetSnapshotResponse> {
    const parsed = Schemas.ZGetBudgetSnapshotRequest.safeParse(raw);
    if (!parsed.success) {
      return {
        isSuccess: false,
        message: this.reject(Schemas.LogAction.GetBudgetSnapshot, raw).message,
      };
    }
    const opened = await this.openLedger(parsed.data.companyId);
    if (!opened) return { isSuccess: false, message: "No usable ledger" };
    const { ledger, reservations } = opened;
    return {
      isSuccess: true,
      message: "Budget snapshot read",
      snapshot: {
        spentMicros: ledger.spentMicros,
        budgetMicros: ledger.budgetMicros,
        heldMicros: reservations.reduce((sum, reservation) => sum + reservation.amountMicros, 0),
        openReservationCount: reservations.length,
      },
    };
  }

  getTimings(): Schemas.BudgetTimingsResponse {
    return {
      isSuccess: true,
      message: "Budget timings read",
      timingsSince: this.timingsSince,
      timings: {
        admitTurn: Schemas.summarizeDurations(
          this.samples[Schemas.BudgetTimedOperationEnum.AdmitTurn].slice(
            -Schemas.BUDGET_TIMING_MAX_SAMPLES,
          ),
        ),
        reserve: Schemas.summarizeDurations(
          this.samples[Schemas.BudgetTimedOperationEnum.Reserve].slice(
            -Schemas.BUDGET_TIMING_MAX_SAMPLES,
          ),
        ),
        settle: Schemas.summarizeDurations(
          this.samples[Schemas.BudgetTimedOperationEnum.Settle].slice(
            -Schemas.BUDGET_TIMING_MAX_SAMPLES,
          ),
        ),
      },
    };
  }

  resetTimings(): Schemas.ApiResponse {
    this.samples = BudgetDO.emptySamples();
    this.timingsSince = Date.now();
    return { isSuccess: true, message: "Budget timings reset" };
  }

  private static emptySamples(): Record<Schemas.BudgetTimedOperationEnum, number[]> {
    return {
      [Schemas.BudgetTimedOperationEnum.AdmitTurn]: [],
      [Schemas.BudgetTimedOperationEnum.Reserve]: [],
      [Schemas.BudgetTimedOperationEnum.Settle]: [],
    };
  }

  private async timed<T>(
    operation: Schemas.BudgetTimedOperationEnum,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      const samples = this.samples[operation];
      samples.push(Date.now() - startedAt);
      // DEV_NOTE: Trimmed in chunks, so a busy DO doesn't shift the array on every call
      if (samples.length >= Schemas.BUDGET_TIMING_MAX_SAMPLES * 2) {
        samples.splice(0, samples.length - Schemas.BUDGET_TIMING_MAX_SAMPLES);
      }
    }
  }

  private async runAdmitTurn(
    raw: Schemas.AdmitBudgetTurnRequest,
  ): Promise<Schemas.BudgetAdmissionResponse> {
    const action = Schemas.LogAction.AdmitBudgetTurn;
    const parsed = Schemas.ZAdmitBudgetTurnRequest.safeParse(raw);
    if (!parsed.success) return this.reject(action, raw);
    const request = parsed.data;

    const opened = await this.openLedger(request.companyId);
    if (!opened) return this.refuse(action, Schemas.BudgetRefusalEnum.Unavailable, request);
    const { ledger, reservations, now } = opened;

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
      return this.refuse(action, admitted.refusal, request);
    }
    return { isSuccess: true, message: "Turn admitted" };
  }

  private async runReserve(
    raw: Schemas.ReserveBudgetRequest,
  ): Promise<Schemas.BudgetReservationResponse> {
    const action = Schemas.LogAction.ReserveBudget;
    const parsed = Schemas.ZReserveBudgetRequest.safeParse(raw);
    if (!parsed.success) return this.reject(action, raw);
    const request = parsed.data;

    const opened = await this.openLedger(request.companyId);
    if (!opened) return this.refuse(action, Schemas.BudgetRefusalEnum.Unavailable, request);
    const { ledger, reservations, now } = opened;

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
      return this.refuse(action, refusal, request);
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
  private async runSettle(raw: Schemas.SettleBudgetRequest): Promise<Schemas.ApiResponse> {
    const parsed = Schemas.ZSettleBudgetRequest.safeParse(raw);
    if (!parsed.success) return this.reject(Schemas.LogAction.SettleBudget, raw);
    const request = parsed.data;

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

  // DEV_NOTE: The shared opening of admitTurn and reserve: a ledger for this company and the current period (loaded
  // when due), then the expired holds charged, and only then the ledger read the caller checks against, so an expired
  // hold is counted as spent, never dropped from both spent and held. null = no usable ledger (fail closed).
  private async openLedger(companyId: string): Promise<{
    ledger: Schemas.BudgetLedger;
    reservations: Schemas.BudgetReservation[];
    now: number;
  } | null> {
    if (!(await this.ensureLedger(companyId))) return null;
    const now = Date.now();
    const reservations = this.liveReservations(now);
    const ledger = this.getLedger();
    return ledger ? { ledger, reservations, now } : null;
  }

  // DEV_NOTE: true when there is a ledger for this company and the current period. Loads it (one load at a time; a
  // caller arriving meanwhile waits for the same one) when the period changed, the DO is new, or the budget is due for
  // a refresh, unless a load failed within BUDGET_LOAD_RETRY_MS. A failed refresh keeps the current period's ledger.
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
    const isBackingOff = now - this.lastFailedLoadAt < Constants.BUDGET_LOAD_RETRY_MS;
    if (!isFresh && (!isBackingOff || this.loading)) {
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
      this.lastFailedLoadAt = Date.now();
      return;
    }

    const budgetMicros = Schemas.usdToMicros(seed.spendingBudgetUsd);
    const current = this.getLedger();
    if (isSpendNeeded || !current || current.periodKey !== periodKey) {
      if (seed.spentUsd === undefined) {
        this.lastFailedLoadAt = Date.now();
        return;
      }
      const opened = BudgetLedgerProvider.openPeriod({
        companyId,
        now: startedAt,
        budgetMicros,
        spentMicros: Schemas.usdToMicros(seed.spentUsd),
      });
      this.pruneUsers(opened.dayKey);
      this.pruneAlerts(opened.periodKey);
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

  // DEV_NOTE: A request that doesn't parse is refused (fail closed) and logged as an error: callers are our own code
  private reject(
    action: Schemas.LogAction,
    raw: unknown,
  ): { isSuccess: false; message: string; refusal: Schemas.BudgetRefusalEnum } {
    AppLogger.error({
      category: Schemas.LogCategory.Budget,
      action,
      message: "Invalid budget request",
      metadata: { request: raw },
    });
    return {
      isSuccess: false,
      message: "Invalid budget request",
      refusal: Schemas.BudgetRefusalEnum.Unavailable,
    };
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
    if (refusal === Schemas.BudgetRefusalEnum.CompanyBudget) {
      const ledger = this.getLedger();
      this.alertOnce(ledger?.periodKey ?? Schemas.budgetPeriodKey(Date.now()), EXHAUSTED_ALERT, {
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.ExhaustCompanyBudget,
        message: "Company budget used up; model calls refused",
        metadata: {
          companyId: request.companyId,
          periodKey: ledger?.periodKey ?? null,
          spentUsd: ledger ? Schemas.microsToUsd(ledger.spentMicros) : null,
          budgetUsd: ledger ? Schemas.microsToUsd(ledger.budgetMicros) : null,
        },
      });
    }
    return { isSuccess: false, message: "Budget refused", refusal };
  }

  private getLedger(): Schemas.BudgetLedger | null {
    const parsed = Schemas.ZBudgetLedger.safeParse(this.ctx.storage.kv.get(LEDGER_KEY));
    return parsed.success ? parsed.data : null;
  }

  private putLedger(ledger: Schemas.BudgetLedger): void {
    this.ctx.storage.kv.put(LEDGER_KEY, ledger);
    this.alertReachedThresholds(ledger);
  }

  private alertReachedThresholds(ledger: Schemas.BudgetLedger): void {
    for (const percent of BudgetLedgerProvider.reachedAlertThresholds(ledger)) {
      this.alertOnce(ledger.periodKey, String(percent), {
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.ReachBudgetThreshold,
        message: `Company budget ${percent}% used`,
        metadata: {
          companyId: ledger.companyId,
          periodKey: ledger.periodKey,
          thresholdPercent: percent,
          spentUsd: Schemas.microsToUsd(ledger.spentMicros),
          budgetUsd: Schemas.microsToUsd(ledger.budgetMicros),
        },
      });
    }
  }

  // DEV_NOTE: Logs the alert unless this period already has it. Marked before logging, with no await between, so two
  // calls in flight can't both send it.
  private alertOnce(
    periodKey: string,
    alert: string,
    entry: Parameters<typeof AppLogger.error>[0],
  ): void {
    const key = `${ALERT_PREFIX}${periodKey}:${alert}`;
    if (this.ctx.storage.kv.get(key) !== undefined) return;
    this.ctx.storage.kv.put(key, Date.now());
    AppLogger.error(entry);
  }

  private pruneAlerts(periodKey: string): void {
    for (const [key] of this.ctx.storage.kv.list({ prefix: ALERT_PREFIX })) {
      if (!key.startsWith(`${ALERT_PREFIX}${periodKey}:`)) {
        this.ctx.storage.kv.delete(key);
      }
    }
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
