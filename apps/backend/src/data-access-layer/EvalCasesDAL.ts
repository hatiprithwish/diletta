import { and, asc, desc, eq, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";
import type { EmptyRelations, SQL } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbotConfigs, chatbots, evalCases, evalResults, evalRuns } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). M4-6 creates customer cases from quality
// issues; M4-8 lists, reads and edits them on the Tests page. Platform cases (company_id null) are written only by the
// platform suite's sync (M5-5, the *PlatformEvalCase* methods, in withPlatform: they filter on company_id IS NULL
// instead); the Tests page reads them (RLS lets every tenant read them) and never edits one.
export default class EvalCasesDAL {
  async createEvalCase(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateEvalCaseDALRequest,
  ) {
    const response: Schemas.EvalCaseDALResponse = { isSuccess: false };
    // DEV_NOTE: name, input and expectations are chat text (rewritten, but still text), so they stay out of the log
    const metadata = { companyId: params.companyId, chatbotId: params.chatbotId };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the chatbot exists in the company before writing
      const chatbotConditions = [
        eq(chatbots.id, params.chatbotId),
        eq(chatbots.companyId, params.companyId),
      ];
      const [chatbot] = await tx
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(...chatbotConditions))
        .limit(1);

      if (!chatbot) {
        const message = "Chatbot not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEvalCase,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      const [evalCase] = await tx
        .insert(evalCases)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          name: params.name,
          input: params.input,
          expectations: params.expectations,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Eval case created successfully";
      response.evalCase = evalCase;
    } catch (error) {
      const message = "Unknown error in creating eval case";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateEvalCase,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The cases as the Tests page reads them, with their chatbot's name (left join: null for a platform case or a
  // removed chatbot)
  private dashboardQuery(tx: NodePgTransaction<EmptyRelations>) {
    const chatbotJoinConditions = [
      eq(chatbots.id, evalCases.chatbotId),
      eq(chatbots.companyId, evalCases.companyId),
    ];
    return tx
      .select({
        id: evalCases.id,
        publicId: evalCases.publicId,
        companyId: evalCases.companyId,
        chatbotId: evalCases.chatbotId,
        platformKey: evalCases.platformKey,
        name: evalCases.name,
        input: evalCases.input,
        expectations: evalCases.expectations,
        isSafety: evalCases.isSafety,
        isActive: evalCases.isActive,
        createdAt: evalCases.createdAt,
        updatedAt: evalCases.updatedAt,
        chatbotName: chatbots.name,
      })
      .from(evalCases)
      .leftJoin(chatbots, and(...chatbotJoinConditions));
  }

  // DEV_NOTE: The company's cases (one chatbot's when chatbotId is set) and every platform case
  private dashboardConditions(params: Schemas.EvalCasesFilterDALRequest) {
    const ownConditions = [eq(evalCases.companyId, params.companyId)];
    if (params.chatbotId !== null) ownConditions.push(eq(evalCases.chatbotId, params.chatbotId));
    return [or(and(...ownConditions), isNull(evalCases.companyId))];
  }

  async getEvalCases(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetEvalCasesDALRequest,
  ) {
    const response: Schemas.DashboardEvalCasesDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.EvalCaseSortColumn.CreatedAt]: evalCases.createdAt,
        [Schemas.EvalCaseSortColumn.Name]: evalCases.name,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const selected = await this.dashboardQuery(tx)
        .where(and(...this.dashboardConditions(params)))
        // DEV_NOTE: id breaks ties, so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(evalCases.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Eval cases fetched successfully";
      response.evalCases = selected;
    } catch (error) {
      const message = "Unknown error in listing eval cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardEvalCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getEvalCasesCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.EvalCasesFilterDALRequest,
  ) {
    const response: Schemas.EvalCasesCountDALResponse = { isSuccess: false };

    try {
      const [result] = await tx
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(evalCases)
        .where(and(...this.dashboardConditions(params)));

      response.isSuccess = true;
      response.message = "Eval cases counted successfully";
      response.totalRecords = result?.total ?? 0;
    } catch (error) {
      const message = "Unknown error in counting eval cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountDashboardEvalCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One case by its public id: the company's own or a platform case. isForUpdate (an edit) finds the
  // company's own only and locks it (the case row only: Postgres refuses to lock the nullable side of an outer join).
  async getEvalCase(tx: NodePgTransaction<EmptyRelations>, params: Schemas.FindEvalCaseDALRequest) {
    const response: Schemas.DashboardEvalCaseDALResponse = { isSuccess: false };

    try {
      const conditions: (SQL | undefined)[] = [eq(evalCases.publicId, params.publicId)];
      if (params.isForUpdate) {
        conditions.push(eq(evalCases.companyId, params.companyId));
      } else {
        conditions.push(or(eq(evalCases.companyId, params.companyId), isNull(evalCases.companyId)));
      }
      const query = this.dashboardQuery(tx)
        .where(and(...conditions))
        .limit(1);
      const [selected] = params.isForUpdate
        ? await query.for("update", { of: evalCases })
        : await query;

      if (!selected) {
        const message = "Eval case not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetDashboardEvalCase,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval case fetched successfully";
      response.evalCase = selected;
    } catch (error) {
      const message = "Unknown error in fetching eval case";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetDashboardEvalCase,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Edits the company's own case (never a platform one: the DAL matches company_id). An absent field keeps its
  // value. name, input and expectations are case text, so they stay out of the log.
  async updateEvalCase(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateEvalCaseDALRequest,
  ) {
    const response: Schemas.EvalCaseDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, id: params.id };

    try {
      const conditions = [eq(evalCases.id, params.id), eq(evalCases.companyId, params.companyId)];
      const [updated] = await tx
        .update(evalCases)
        .set({
          name: params.name,
          input: params.input,
          expectations: params.expectations,
          isActive: params.isActive,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!updated) {
        const message = "Eval case not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateEvalCase,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Eval case updated successfully";
      response.evalCase = updated;
    } catch (error) {
      const message = "Unknown error in updating eval case";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateEvalCase,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Each case's newest run among this company's results (the highest eval_run_id: ids grow with time), only
  // runs of chatbotId's configs when set (a platform case runs against every chatbot), and how its attempts went in it,
  // with the run's k and status (a run still going leaves its unfinished cases undecided). A case never run has no entry.
  async getLatestEvalCaseResults(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetLatestEvalCaseResultsDALRequest,
  ) {
    const response: Schemas.LatestEvalCaseResultsDALResponse = { isSuccess: false };

    if (params.evalCaseIds.length === 0) {
      response.isSuccess = true;
      response.message = "No eval cases to look up";
      response.results = [];
      return response;
    }

    try {
      const latestRunJoinConditions = [
        eq(evalRuns.id, evalResults.evalRunId),
        eq(evalRuns.companyId, evalResults.companyId),
      ];
      const latestConfigJoinConditions = [
        eq(chatbotConfigs.id, evalRuns.chatbotConfigId),
        eq(chatbotConfigs.companyId, evalRuns.companyId),
      ];
      const latestConditions = [
        eq(evalResults.companyId, params.companyId),
        inArray(evalResults.evalCaseId, params.evalCaseIds),
      ];
      if (params.chatbotId !== null) {
        latestConditions.push(eq(chatbotConfigs.chatbotId, params.chatbotId));
      }
      const latest = tx
        .select({
          evalCaseId: evalResults.evalCaseId,
          evalRunId: max(evalResults.evalRunId).as("latest_eval_run_id"),
        })
        .from(evalResults)
        .innerJoin(evalRuns, and(...latestRunJoinConditions))
        .innerJoin(chatbotConfigs, and(...latestConfigJoinConditions))
        .where(and(...latestConditions))
        .groupBy(evalResults.evalCaseId)
        .as("latest");
      const latestJoinConditions = [
        eq(latest.evalCaseId, evalResults.evalCaseId),
        eq(latest.evalRunId, evalResults.evalRunId),
      ];
      const runJoinConditions = [
        eq(evalRuns.id, evalResults.evalRunId),
        eq(evalRuns.companyId, evalResults.companyId),
      ];
      const selected = await tx
        .select({
          evalCaseId: evalResults.evalCaseId,
          evalRunPublicId: evalRuns.publicId,
          evalRunStatus: evalRuns.status,
          k: evalRuns.k,
          attemptCount: sql<number>`count(*)`.mapWith(Number),
          passedAttemptCount: sql<number>`count(*) filter (where ${evalResults.hasPassed})`.mapWith(
            Number,
          ),
          createdAt: sql<Date>`max(${evalResults.createdAt})`.mapWith(evalResults.createdAt),
        })
        .from(evalResults)
        .innerJoin(latest, and(...latestJoinConditions))
        .innerJoin(evalRuns, and(...runJoinConditions))
        .where(eq(evalResults.companyId, params.companyId))
        .groupBy(evalResults.evalCaseId, evalRuns.publicId, evalRuns.status, evalRuns.k);

      response.isSuccess = true;
      response.message = "Latest eval case results fetched successfully";
      response.results = selected;
    } catch (error) {
      const message = "Unknown error in fetching latest eval case results";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetLatestEvalCaseResults,
        message,
        error,
        metadata: {
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          caseCount: params.evalCaseIds.length,
        },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The active cases that run against one chatbot (its own and the platform's), and how many are safety cases
  async countActiveEvalCases(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CountActiveEvalCasesDALRequest,
  ) {
    const response: Schemas.ActiveEvalCaseCountsDALResponse = { isSuccess: false };

    try {
      const ownConditions = [
        eq(evalCases.companyId, params.companyId),
        eq(evalCases.chatbotId, params.chatbotId),
      ];
      const conditions = [
        eq(evalCases.isActive, true),
        or(and(...ownConditions), isNull(evalCases.companyId)),
      ];
      const [result] = await tx
        .select({
          caseCount: sql<number>`count(*)`.mapWith(Number),
          safetyCaseCount: sql<number>`count(*) filter (where ${evalCases.isSafety})`.mapWith(
            Number,
          ),
        })
        .from(evalCases)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Active eval cases counted successfully";
      response.caseCount = result?.caseCount ?? 0;
      response.safetyCaseCount = result?.safetyCaseCount ?? 0;
    } catch (error) {
      const message = "Unknown error in counting active eval cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountActiveEvalCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The active cases one chatbot's eval run runs (M5-2): its own and every platform case, safety cases first,
  // then by name (a fixed order, so a run's attempts go in the same order every time). Case text stays out of the log.
  async getRunnableEvalCases(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetRunnableEvalCasesDALRequest,
  ) {
    const response: Schemas.EvalCasesDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: The company's case of this chatbot, or a platform case: company_id and chatbot_id are null together
      // (CHK_eval_cases_platform_chatbot_id), so each column is matched or null on its own
      const conditions = [
        eq(evalCases.isActive, true),
        or(eq(evalCases.companyId, params.companyId), isNull(evalCases.companyId)),
        or(eq(evalCases.chatbotId, params.chatbotId), isNull(evalCases.chatbotId)),
      ];
      if (params.isSafetyOnly) conditions.push(eq(evalCases.isSafety, true));
      const selected = await tx
        .select()
        .from(evalCases)
        .where(and(...conditions))
        .orderBy(desc(evalCases.isSafety), asc(evalCases.name), asc(evalCases.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Runnable eval cases fetched successfully";
      response.evalCases = selected;
    } catch (error) {
      const message = "Unknown error in fetching runnable eval cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetRunnableEvalCases,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every platform case the sync owns (a platform_key set), on or off, in withPlatform. Case text stays out of
  // the log.
  async getPlatformEvalCases(tx: NodePgTransaction<EmptyRelations>) {
    const response: Schemas.EvalCasesDALResponse = { isSuccess: false };

    try {
      const conditions = [isNull(evalCases.companyId), isNotNull(evalCases.platformKey)];
      const selected = await tx
        .select()
        .from(evalCases)
        .where(and(...conditions))
        .orderBy(asc(evalCases.id));

      response.isSuccess = true;
      response.message = "Platform eval cases fetched successfully";
      response.evalCases = selected;
    } catch (error) {
      const message = "Unknown error in fetching platform eval cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPlatformEvalCases,
        message,
        error,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A new platform case (company and chatbot null), active
  async createPlatformEvalCase(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreatePlatformEvalCaseDALRequest,
  ) {
    const response: Schemas.EvalCaseDALResponse = { isSuccess: false };
    const metadata = { platformKey: params.platformKey };

    try {
      const [evalCase] = await tx
        .insert(evalCases)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: null,
          chatbotId: null,
          platformKey: params.platformKey,
          name: params.name,
          input: params.input,
          expectations: params.expectations,
          isSafety: params.isSafety,
          isActive: true,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Platform eval case created successfully";
      response.evalCase = evalCase;
    } catch (error) {
      const message = "Unknown error in creating platform eval case";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreatePlatformEvalCase,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A keyed platform case rewritten to the case in code and turned on again
  async updatePlatformEvalCase(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdatePlatformEvalCaseDALRequest,
  ) {
    const response: Schemas.EvalCaseDALResponse = { isSuccess: false };
    const metadata = { id: params.id, platformKey: params.platformKey };

    try {
      const conditions = [
        eq(evalCases.id, params.id),
        isNull(evalCases.companyId),
        eq(evalCases.platformKey, params.platformKey),
      ];
      const [updated] = await tx
        .update(evalCases)
        .set({
          name: params.name,
          input: params.input,
          expectations: params.expectations,
          isSafety: params.isSafety,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!updated) {
        const message = "Platform eval case not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdatePlatformEvalCase,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Platform eval case updated successfully";
      response.evalCase = updated;
    } catch (error) {
      const message = "Unknown error in updating platform eval case";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdatePlatformEvalCase,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Turns off keyed platform cases that are on and aren't safety cases (a platform safety case stays active,
  // CHK_eval_cases_platform_safety_active)
  async deactivatePlatformEvalCases(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeactivatePlatformEvalCasesDALRequest,
  ) {
    const response: Schemas.PlatformEvalCasesWriteDALResponse = { isSuccess: false };

    if (params.ids.length === 0) {
      response.isSuccess = true;
      response.message = "No platform eval cases to turn off";
      response.changedCount = 0;
      return response;
    }

    try {
      const conditions = [
        inArray(evalCases.id, params.ids),
        isNull(evalCases.companyId),
        isNotNull(evalCases.platformKey),
        eq(evalCases.isSafety, false),
        eq(evalCases.isActive, true),
      ];
      const updated = await tx
        .update(evalCases)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(...conditions))
        .returning({ id: evalCases.id });

      response.isSuccess = true;
      response.message = "Platform eval cases turned off successfully";
      response.changedCount = updated.length;
    } catch (error) {
      const message = "Unknown error in turning off platform eval cases";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeactivatePlatformEvalCases,
        message,
        error,
        metadata: { count: params.ids.length },
      });
      response.message = message;
    }

    return response;
  }
}
