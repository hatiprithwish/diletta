import { and, asc, countDistinct, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { EmptyRelations, SQL } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  chatbotConfigs,
  chatbots,
  companyConnections,
  evalCases,
  evalResults,
  evalRuns,
  files,
} from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

const RESULT_ATTEMPT_INDEX = "UNQ_eval_results_eval_run_id_eval_case_id_attempt";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). The Tests page (M4-8) reads runs and their
// results; the eval harness (M5-2) writes them (createEvalRun, createEvalResult, finishEvalRun), and every model call
// of a run adds its cost (addEvalRunCost). A result's case is
// the company's own or a platform case (company_id null, readable by every tenant under RLS), so every case join takes
// either.
export default class EvalRunsDAL {
  // DEV_NOTE: The case of a result: the result's company's own, or a platform case
  private caseJoinConditions() {
    return [
      eq(evalCases.id, evalResults.evalCaseId),
      or(eq(evalCases.companyId, evalResults.companyId), isNull(evalCases.companyId)),
    ];
  }

  // DEV_NOTE: count(*) of the group's attempts that passed
  private passedAttemptCount() {
    return sql<number>`count(*) filter (where ${evalResults.hasPassed})`.mapWith(Number);
  }

  // DEV_NOTE: The runs as the Tests page reads them: with the config (inner join: configs are archived, never deleted)
  // and its chatbot's name (left join: a removed chatbot leaves its runs)
  private runQuery(tx: NodePgTransaction<EmptyRelations>) {
    const configJoinConditions = [
      eq(chatbotConfigs.id, evalRuns.chatbotConfigId),
      eq(chatbotConfigs.companyId, evalRuns.companyId),
    ];
    const chatbotJoinConditions = [
      eq(chatbots.id, chatbotConfigs.chatbotId),
      eq(chatbots.companyId, chatbotConfigs.companyId),
    ];
    return tx
      .select({
        id: evalRuns.id,
        publicId: evalRuns.publicId,
        companyId: evalRuns.companyId,
        chatbotConfigId: evalRuns.chatbotConfigId,
        companyConnectionId: evalRuns.companyConnectionId,
        evalCaseIds: evalRuns.evalCaseIds,
        resetAt: evalRuns.resetAt,
        trigger: evalRuns.trigger,
        harnessVersion: evalRuns.harnessVersion,
        k: evalRuns.k,
        status: evalRuns.status,
        caseCount: evalRuns.caseCount,
        passAllKCount: evalRuns.passAllKCount,
        hasPassed: evalRuns.hasPassed,
        failure: evalRuns.failure,
        costUsd: evalRuns.costUsd,
        finishedAt: evalRuns.finishedAt,
        createdAt: evalRuns.createdAt,
        updatedAt: evalRuns.updatedAt,
        configPublicId: chatbotConfigs.publicId,
        configVersion: chatbotConfigs.configVersion,
        configStatus: chatbotConfigs.status,
        chatbotName: chatbots.name,
      })
      .from(evalRuns)
      .innerJoin(chatbotConfigs, and(...configJoinConditions))
      .leftJoin(chatbots, and(...chatbotJoinConditions));
  }

  // DEV_NOTE: The list's filter, shared by the list and its count. The chatbot is the run's config's.
  private runConditions(params: Schemas.EvalRunsFilterDALRequest): SQL[] {
    const conditions: SQL[] = [
      eq(evalRuns.companyId, params.companyId),
      eq(chatbotConfigs.companyId, params.companyId),
    ];
    if (params.chatbotId !== null) conditions.push(eq(chatbotConfigs.chatbotId, params.chatbotId));
    return conditions;
  }

  async getEvalRuns(tx: NodePgTransaction<EmptyRelations>, params: Schemas.GetEvalRunsDALRequest) {
    const response: Schemas.DashboardEvalRunsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.EvalRunSortColumn.CreatedAt]: evalRuns.createdAt,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const selected = await this.runQuery(tx)
        .where(and(...this.runConditions(params)))
        // DEV_NOTE: id breaks ties (same created_at), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(evalRuns.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Eval runs fetched successfully";
      response.evalRuns = selected;
    } catch (error) {
      const message = "Unknown error in listing eval runs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardEvalRuns,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getEvalRunsCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.EvalRunsFilterDALRequest,
  ) {
    const response: Schemas.EvalRunsCountDALResponse = { isSuccess: false };

    try {
      const configJoinConditions = [
        eq(chatbotConfigs.id, evalRuns.chatbotConfigId),
        eq(chatbotConfigs.companyId, evalRuns.companyId),
      ];
      const [result] = await tx
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(evalRuns)
        .innerJoin(chatbotConfigs, and(...configJoinConditions))
        .where(and(...this.runConditions(params)));

      response.isSuccess = true;
      response.message = "Eval runs counted successfully";
      response.totalRecords = result?.total ?? 0;
    } catch (error) {
      const message = "Unknown error in counting eval runs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountDashboardEvalRuns,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getEvalRun(tx: NodePgTransaction<EmptyRelations>, params: Schemas.FindEvalRunDALRequest) {
    return await this.findRun(
      tx,
      [eq(evalRuns.publicId, params.publicId)],
      params,
      params.isLocked,
    );
  }

  async getEvalRunById(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindEvalRunByIdDALRequest,
  ) {
    return await this.findRun(tx, [eq(evalRuns.id, params.id)], params);
  }

  // DEV_NOTE: One run within the company; isNotFound when there is none. isLocked: FOR UPDATE on the run row.
  private async findRun(
    tx: NodePgTransaction<EmptyRelations>,
    match: SQL[],
    params: Schemas.FindEvalRunDALRequest | Schemas.FindEvalRunByIdDALRequest,
    isLocked = false,
  ) {
    const response: Schemas.DashboardEvalRunDALResponse = { isSuccess: false };

    try {
      const conditions = [...match, eq(evalRuns.companyId, params.companyId)];
      const query = this.runQuery(tx)
        .where(and(...conditions))
        .limit(1);
      // DEV_NOTE: The lock takes the run row only, not the joined config or chatbot
      const [selected] = isLocked ? await query.for("update", { of: evalRuns }) : await query;

      if (!selected) {
        const message = "Eval run not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetDashboardEvalRun,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval run fetched successfully";
      response.evalRun = selected;
    } catch (error) {
      const message = "Unknown error in fetching eval run";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardEvalRun,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A config's newest run; isNotFound when it was never tested
  async getLatestEvalRun(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindLatestEvalRunDALRequest,
  ) {
    const response: Schemas.DashboardEvalRunDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalRuns.chatbotConfigId, params.chatbotConfigId),
        eq(evalRuns.companyId, params.companyId),
      ];
      const [selected] = await this.runQuery(tx)
        .where(and(...conditions))
        .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
        .limit(1);

      if (!selected) {
        response.message = "Config has no eval run";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Latest eval run fetched successfully";
      response.evalRun = selected;
    } catch (error) {
      const message = "Unknown error in fetching latest eval run";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetLatestEvalRun,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every safety case of these runs with how many of its attempts ran and passed, in one grouped read
  async getEvalRunSafetyCases(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetEvalRunSafetyCasesDALRequest,
  ) {
    const response: Schemas.EvalRunSafetyCasesDALResponse = { isSuccess: false };

    if (params.evalRunIds.length === 0) {
      response.isSuccess = true;
      response.message = "No eval runs to tally";
      response.safetyCases = [];
      return response;
    }

    try {
      const conditions = [
        eq(evalResults.companyId, params.companyId),
        inArray(evalResults.evalRunId, params.evalRunIds),
        eq(evalCases.isSafety, true),
      ];
      const selected = await tx
        .select({
          evalRunId: evalResults.evalRunId,
          attemptCount: sql<number>`count(*)`.mapWith(Number),
          passedAttemptCount: this.passedAttemptCount(),
        })
        .from(evalResults)
        .innerJoin(evalCases, and(...this.caseJoinConditions()))
        .where(and(...conditions))
        .groupBy(evalResults.evalRunId, evalResults.evalCaseId);

      response.isSuccess = true;
      response.message = "Eval run safety cases fetched successfully";
      response.safetyCases = selected;
    } catch (error) {
      const message = "Unknown error in fetching eval run safety cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEvalRunSafetyCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One run's cases, grouped from its results. Result: failed first, then still running, then passed (the
  // three states of Schemas.evalCaseRunResult), safety cases first within each, then by name; Name: by name. Case id
  // breaks ties so pages never overlap.
  async getEvalRunCases(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetEvalRunCasesDALRequest,
  ) {
    const response: Schemas.EvalRunCasesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalResults.companyId, params.companyId),
        eq(evalResults.evalRunId, params.evalRunId),
      ];
      const passedAttemptCount = this.passedAttemptCount();
      const nameOrder = params.sortDirection === Schemas.SortDirection.Desc ? desc : asc;
      // DEV_NOTE: 0 failed (an attempt failed, or the run ended short of k passes), 1 still running, 2 passed
      const resultOrder = sql`case
        when count(*) filter (where ${evalResults.hasPassed}) >= ${params.k} then 2
        when count(*) > count(*) filter (where ${evalResults.hasPassed}) or not ${params.isRunUnderway}::boolean then 0
        else 1
      end`;
      const orderBy =
        params.sortColumn === Schemas.EvalRunCaseSortColumn.Result
          ? [resultOrder, desc(evalCases.isSafety), asc(evalCases.name)]
          : [nameOrder(evalCases.name)];
      const offset = (params.pageNo - 1) * params.pageSize;

      const selected = await tx
        .select({
          evalCasePublicId: evalCases.publicId,
          name: evalCases.name,
          isSafety: evalCases.isSafety,
          caseCompanyId: evalCases.companyId,
          attemptCount: sql<number>`count(*)`.mapWith(Number),
          passedAttemptCount,
        })
        .from(evalResults)
        .innerJoin(evalCases, and(...this.caseJoinConditions()))
        .where(and(...conditions))
        .groupBy(
          evalCases.id,
          evalCases.publicId,
          evalCases.name,
          evalCases.isSafety,
          evalCases.companyId,
        )
        .orderBy(...orderBy, asc(evalCases.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Eval run cases fetched successfully";
      response.cases = selected;
    } catch (error) {
      const message = "Unknown error in listing eval run cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEvalRunCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getEvalRunCasesCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountEvalRunCasesDALRequest,
  ) {
    const response: Schemas.EvalRunsCountDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalResults.companyId, params.companyId),
        eq(evalResults.evalRunId, params.evalRunId),
      ];
      const [result] = await tx
        .select({ total: countDistinct(evalResults.evalCaseId) })
        .from(evalResults)
        .innerJoin(evalCases, and(...this.caseJoinConditions()))
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Eval run cases counted successfully";
      response.totalRecords = result?.total ?? 0;
    } catch (error) {
      const message = "Unknown error in counting eval run cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountEvalRunCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One case's attempts in a run, in order, each with its transcript file's public id (left join on the file
  // the result points at, of the same company). isNotFound when the case has no result in the run.
  async getEvalRunCaseAttempts(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetEvalRunCaseAttemptsDALRequest,
  ) {
    const response: Schemas.EvalRunCaseAttemptsDALResponse = { isSuccess: false };

    try {
      const fileJoinConditions = [
        eq(files.id, evalResults.transcriptFileId),
        eq(files.companyId, evalResults.companyId),
      ];
      const conditions = [
        eq(evalResults.companyId, params.companyId),
        eq(evalResults.evalRunId, params.evalRunId),
        eq(evalCases.publicId, params.evalCasePublicId),
      ];
      const selected = await tx
        .select({
          evalCasePublicId: evalCases.publicId,
          name: evalCases.name,
          isSafety: evalCases.isSafety,
          caseCompanyId: evalCases.companyId,
          attempt: evalResults.attempt,
          hasPassed: evalResults.hasPassed,
          graderOutput: evalResults.graderOutput,
          latencyMs: evalResults.latencyMs,
          transcriptFilePublicId: files.publicId,
          createdAt: evalResults.createdAt,
        })
        .from(evalResults)
        .innerJoin(evalCases, and(...this.caseJoinConditions()))
        .leftJoin(files, and(...fileJoinConditions))
        .where(and(...conditions))
        .orderBy(asc(evalResults.attempt), asc(evalResults.id));

      const [first, ...rest] = selected;
      if (!first) {
        const message = "Eval case has no result in this run";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetEvalRunCaseAttempts,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval run case attempts fetched successfully";
      response.attempts = [first, ...rest];
    } catch (error) {
      const message = "Unknown error in fetching eval run case attempts";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEvalRunCaseAttempts,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Each config's newest run in one read (DISTINCT ON config, newest first); a config never tested has none
  async getLatestEvalRunsByConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetLatestEvalRunsByConfigDALRequest,
  ) {
    const response: Schemas.LatestEvalRunsByConfigDALResponse = { isSuccess: false };

    try {
      if (params.chatbotConfigIds.length === 0) {
        response.isSuccess = true;
        response.message = "No configs to read runs for";
        response.runs = [];
        return response;
      }
      const conditions = [
        eq(evalRuns.companyId, params.companyId),
        inArray(evalRuns.chatbotConfigId, params.chatbotConfigIds),
      ];
      const runs = await tx
        .selectDistinctOn([evalRuns.chatbotConfigId], {
          id: evalRuns.id,
          chatbotConfigId: evalRuns.chatbotConfigId,
          k: evalRuns.k,
          status: evalRuns.status,
          hasPassed: evalRuns.hasPassed,
        })
        .from(evalRuns)
        .where(and(...conditions))
        .orderBy(evalRuns.chatbotConfigId, desc(evalRuns.createdAt), desc(evalRuns.id));

      response.isSuccess = true;
      response.message = "Latest eval runs by config fetched successfully";
      response.runs = runs;
    } catch (error) {
      const message = "Unknown error in fetching latest eval runs by config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetLatestEvalRunsByConfig,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // ─── The eval harness's writes (M5-2) ─────────────────────────────────────

  // DEV_NOTE: A new run, Running from the start, with its staging connection and case set. The config and the
  // connection must be the company's (no DB foreign keys); the cases were read by the Repo in the same transaction.
  async createEvalRun(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateEvalRunDALRequest,
  ) {
    const response: Schemas.EvalRunDALResponse = { isSuccess: false };

    try {
      const configConditions = [
        eq(chatbotConfigs.id, params.chatbotConfigId),
        eq(chatbotConfigs.companyId, params.companyId),
      ];
      const [config] = await tx
        .select({ id: chatbotConfigs.id })
        .from(chatbotConfigs)
        .where(and(...configConditions))
        .limit(1);
      const connectionConditions = [
        eq(companyConnections.id, params.companyConnectionId),
        eq(companyConnections.companyId, params.companyId),
      ];
      const [connection] = await tx
        .select({ id: companyConnections.id })
        .from(companyConnections)
        .where(and(...connectionConditions))
        .limit(1);
      if (!config || !connection) {
        const message = config ? "Company connection not found" : "Chatbot config not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEvalRun,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [evalRun] = await tx
        .insert(evalRuns)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotConfigId: params.chatbotConfigId,
          companyConnectionId: params.companyConnectionId,
          evalCaseIds: params.evalCaseIds,
          trigger: params.trigger,
          harnessVersion: params.harnessVersion,
          k: params.k,
          status: Schemas.EvalRunStatusIntEnum.Running,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Eval run created successfully";
      response.evalRun = evalRun;
    } catch (error) {
      const message = "Unknown error in creating eval run";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateEvalRun,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Running → Done / Failed, once (the status condition): a run that already ended is isNotFound
  async finishEvalRun(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FinishEvalRunDALRequest,
  ) {
    const response: Schemas.EvalRunDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalRuns.id, params.id),
        eq(evalRuns.companyId, params.companyId),
        eq(evalRuns.status, Schemas.EvalRunStatusIntEnum.Running),
      ];
      const [evalRun] = await tx
        .update(evalRuns)
        .set({
          status: params.status,
          caseCount: params.caseCount,
          passAllKCount: params.passAllKCount,
          hasPassed: params.hasPassed,
          failure: params.failure,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!evalRun) {
        const message = "Eval run not found or not running";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.FinishEvalRun,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval run finished successfully";
      response.evalRun = evalRun;
    } catch (error) {
      const message = "Unknown error in finishing eval run";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.FinishEvalRun,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: reset_at = now, once the harness's reset went through, only while the run is Running (isNotFound else)
  async markEvalRunReset(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.MarkEvalRunResetDALRequest,
  ) {
    const response: Schemas.EvalRunDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalRuns.id, params.id),
        eq(evalRuns.companyId, params.companyId),
        eq(evalRuns.status, Schemas.EvalRunStatusIntEnum.Running),
      ];
      const [evalRun] = await tx
        .update(evalRuns)
        .set({ resetAt: new Date(), updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!evalRun) {
        const message = "Eval run not found or not running";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.MarkEvalRunReset,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval run marked reset successfully";
      response.evalRun = evalRun;
    } catch (error) {
      const message = "Unknown error in marking eval run reset";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.MarkEvalRunReset,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: cost_usd + addUsd - subtractUsd as one update (numeric, exact), in the transaction that writes the model
  // call, so concurrent calls never lose a cost. Any status: a call recorded or backfilled after the finish still
  // counts. isNotFound when the run is gone.
  async addEvalRunCost(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.AddEvalRunCostDALRequest,
  ) {
    const response: Schemas.EvalRunDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(evalRuns.id, params.id), eq(evalRuns.companyId, params.companyId)];
      const [evalRun] = await tx
        .update(evalRuns)
        .set({
          costUsd: sql`${evalRuns.costUsd} + ${params.addUsd}::numeric - ${params.subtractUsd}::numeric`,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!evalRun) {
        const message = "Eval run not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.AddEvalRunCost,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval run cost added successfully";
      response.evalRun = evalRun;
    } catch (error) {
      const message = "Unknown error in adding eval run cost";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.AddEvalRunCost,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Whether the attempt already has its result: /results answers Duplicate before reading the DO or writing R2
  async hasEvalResult(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.HasEvalResultDALRequest,
  ) {
    const response: Schemas.HasEvalResultDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalResults.companyId, params.companyId),
        eq(evalResults.evalRunId, params.evalRunId),
        eq(evalResults.evalCaseId, params.evalCaseId),
        eq(evalResults.attempt, params.attempt),
      ];
      const [found] = await tx
        .select({ id: evalResults.id })
        .from(evalResults)
        .where(and(...conditions))
        .limit(1);

      response.isSuccess = true;
      response.message = found ? "The attempt has a result" : "The attempt has no result";
      response.hasResult = found !== undefined;
    } catch (error) {
      const message = "Unknown error in checking an eval result";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.HasEvalResult,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One graded attempt (append-only). The run must be the company's and the case the company's own or a
  // platform case (the Repo checks it belongs to the run's chatbot). grader_output is stored as given: the Repo
  // validated it against the current schema. Its text is the harness's, never logged here.
  async createEvalResult(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateEvalResultDALRequest,
  ) {
    const response: Schemas.CreateEvalResultDALResponse = { isSuccess: false };
    const metadata = {
      companyId: params.companyId,
      evalRunId: params.evalRunId,
      evalCaseId: params.evalCaseId,
      attempt: params.attempt,
    };

    try {
      const runConditions = [
        eq(evalRuns.id, params.evalRunId),
        eq(evalRuns.companyId, params.companyId),
      ];
      const [run] = await tx
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(and(...runConditions))
        .limit(1);
      const caseConditions = [
        eq(evalCases.id, params.evalCaseId),
        or(eq(evalCases.companyId, params.companyId), isNull(evalCases.companyId)),
      ];
      const [evalCase] = await tx
        .select({ id: evalCases.id })
        .from(evalCases)
        .where(and(...caseConditions))
        .limit(1);
      if (!run || !evalCase) {
        const message = run ? "Eval case not found" : "Eval run not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEvalResult,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const [created] = await tx
        .insert(evalResults)
        .values({
          companyId: params.companyId,
          evalRunId: params.evalRunId,
          evalCaseId: params.evalCaseId,
          attempt: params.attempt,
          hasPassed: params.hasPassed,
          graderOutput: params.graderOutput,
          transcriptFileId: params.transcriptFileId,
          latencyMs: params.latencyMs,
        })
        .returning({ id: evalResults.id });

      response.isSuccess = true;
      response.message = "Eval result created successfully";
      response.evalResultId = created?.id;
    } catch (error) {
      if (Utility.isUniqueViolation(error, RESULT_ATTEMPT_INDEX)) {
        const message = "This attempt already has a result";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEvalResult,
          message,
          metadata,
        });
        response.message = message;
        response.isConflict = true;
        return response;
      }
      const message = "Unknown error in creating eval result";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateEvalResult,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Per case of the run: attempts recorded and how many passed (grouped from its results)
  async getEvalRunTallies(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetEvalRunTalliesDALRequest,
  ) {
    const response: Schemas.EvalRunTalliesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(evalResults.companyId, params.companyId),
        eq(evalResults.evalRunId, params.evalRunId),
      ];
      const tallies = await tx
        .select({
          evalCaseId: evalResults.evalCaseId,
          isSafety: evalCases.isSafety,
          attemptCount: sql<number>`count(*)`.mapWith(Number),
          passedAttemptCount: this.passedAttemptCount(),
        })
        .from(evalResults)
        .innerJoin(evalCases, and(...this.caseJoinConditions()))
        .where(and(...conditions))
        .groupBy(evalResults.evalCaseId, evalCases.isSafety);

      response.isSuccess = true;
      response.message = "Eval run tallies fetched successfully";
      response.tallies = tallies;
    } catch (error) {
      const message = "Unknown error in fetching eval run tallies";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEvalRunTallies,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
