import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { BudgetDO } from "@/durable-objects/BudgetDO";
import EventOutboxDAL from "@/data-access-layer/EventOutboxDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The load test's side of the backend (M6-5, docs/runbooks/load.md), one method per /eval/load/* route. The
// company is the eval token's, and only the load test company (LOAD_TEST_COMPANY_ID) reaches here (LoadTestMiddleware).
//   startWindow: BudgetDO's timings start over; the window's start is the database's clock, and the ledger as it stands
//     is the baseline the summary is compared with.
//   getSummary: the window so far: the ledger, BudgetDO's timings, the company's model calls (the spend the ledger must
//     have counted) and its outbox rows (how long they waited to be published).
//   reserve / release: one hold against the company's budget, for no user, and its release at no cost, so the harness can
//     drive many at once and count how many the budget admits. A release leaves spend as it was.
// Nothing here writes a table; the only state it touches is BudgetDO's counters, put back by release.
export default class EvalLoadRepo {
  private env: Env;
  private db: NodePgDatabase;
  private modelCallsDal: ModelCallsDAL;
  private eventOutboxDal: EventOutboxDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.modelCallsDal = new ModelCallsDAL();
    this.eventOutboxDal = new EventOutboxDAL();
  }

  async startWindow(params: {
    identity: Schemas.EvalIdentity;
  }): Promise<Schemas.EvalLoadWindowResponse> {
    const { companyId } = params.identity;
    const action = Schemas.LogAction.StartLoadWindow;

    try {
      const started: Schemas.LoadWindowStartDALResponse = await withTenant(
        this.db,
        companyId,
        async (tx) => {
          return await this.modelCallsDal.getLoadWindowStart(tx);
        },
      );
      if (!started.isSuccess || !started.startedAt) {
        return this.fail(action, "The window's start couldn't be read", { companyId });
      }

      const budgetDo = BudgetDO.forCompany(this.env, companyId);
      await budgetDo.resetTimings();
      const snapshot = await budgetDo.getSnapshot({ companyId });
      if (!snapshot.isSuccess || !snapshot.snapshot) {
        return this.fail(action, "The budget couldn't be read", { companyId });
      }

      return {
        isSuccess: true,
        message: "Load window started",
        startedAt: started.startedAt.toISOString(),
        budget: snapshot.snapshot,
      };
    } catch (error) {
      return this.fail(action, "Unknown error in starting the load window", { companyId }, error);
    }
  }

  async getSummary(params: {
    identity: Schemas.EvalIdentity;
    request: Schemas.EvalLoadSummaryApiRequest;
  }): Promise<Schemas.EvalLoadSummaryResponse> {
    const { companyId } = params.identity;
    const action = Schemas.LogAction.GetLoadSummary;
    const since = new Date(params.request.since);

    try {
      const budgetDo = BudgetDO.forCompany(this.env, companyId);
      const snapshot = await budgetDo.getSnapshot({ companyId });
      const timings = await budgetDo.getTimings();
      if (!snapshot.isSuccess || !snapshot.snapshot || !timings.timings) {
        return this.fail(action, "The budget couldn't be read", { companyId });
      }

      const stats = await withTenant(this.db, companyId, async (tx) => {
        const modelCalls = await this.modelCallsDal.getLoadWindowStats(tx, { companyId, since });
        const outbox = await this.eventOutboxDal.getLoadWindowStats(tx, { companyId, since });
        return {
          isSuccess: modelCalls.isSuccess && outbox.isSuccess,
          message: "Load window stats read",
          modelCalls: modelCalls.stats,
          outbox: outbox.stats,
        };
      });
      if (!("modelCalls" in stats) || !stats.modelCalls || !stats.outbox) {
        return this.fail(action, "The window's rows couldn't be read", { companyId });
      }

      return {
        isSuccess: true,
        message: "Load summary read",
        budget: snapshot.snapshot,
        timings: timings.timings,
        timingsSince: timings.timingsSince,
        modelCalls: stats.modelCalls,
        outbox: stats.outbox,
      };
    } catch (error) {
      return this.fail(action, "Unknown error in reading the load summary", { companyId }, error);
    }
  }

  async reserve(params: {
    identity: Schemas.EvalIdentity;
    request: Schemas.EvalLoadReserveApiRequest;
  }): Promise<Schemas.EvalLoadReserveResponse> {
    const { companyId } = params.identity;
    const action = Schemas.LogAction.ReserveLoadBudget;

    try {
      const startedAt = Date.now();
      const reserved = await BudgetDO.forCompany(this.env, companyId).reserve({
        companyId,
        chatbotUserId: null,
        userDailyCostCapUsd: null,
        amountMicros: params.request.amountMicros,
      });
      const serverMs = Date.now() - startedAt;

      if (reserved.isSuccess && reserved.reservationId) {
        return {
          isSuccess: true,
          message: "Budget reserved",
          isAdmitted: true,
          reservationId: reserved.reservationId,
          serverMs,
        };
      }
      // DEV_NOTE: A refusal is an answer (the budget said no); no refusal at all is BudgetDO failing
      if (reserved.refusal) {
        return {
          isSuccess: true,
          message: "Budget refused",
          isAdmitted: false,
          refusal: reserved.refusal,
          serverMs,
        };
      }
      return this.fail(action, "The budget couldn't be reserved", { companyId });
    } catch (error) {
      return this.fail(action, "Unknown error in reserving budget", { companyId }, error);
    }
  }

  async release(params: {
    identity: Schemas.EvalIdentity;
    request: Schemas.EvalLoadReleaseApiRequest;
  }): Promise<Schemas.EvalLoadReleaseResponse> {
    const { companyId } = params.identity;
    const action = Schemas.LogAction.ReleaseLoadBudget;

    try {
      const startedAt = Date.now();
      const settled = await BudgetDO.forCompany(this.env, companyId).settle({
        companyId,
        reservationId: params.request.reservationId,
        costMicros: 0,
      });
      const serverMs = Date.now() - startedAt;
      if (!settled.isSuccess) {
        return this.fail(action, "The hold couldn't be released", { companyId });
      }
      return { isSuccess: true, message: "Budget released", serverMs };
    } catch (error) {
      return this.fail(action, "Unknown error in releasing budget", { companyId }, error);
    }
  }

  private fail(
    action: Schemas.LogAction,
    message: string,
    metadata: Record<string, unknown>,
    error?: unknown,
  ): { isSuccess: false; message: string } {
    AppLogger.error({
      category: Schemas.LogCategory.LoadTest,
      action,
      message,
      error,
      metadata,
    });
    return { isSuccess: false, message };
  }
}
