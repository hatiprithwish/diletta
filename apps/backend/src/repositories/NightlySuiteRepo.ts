import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import EvalRunsDAL from "@/data-access-layer/EvalRunsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The nightly platform suite's alerts (M5-5). The suite itself is the eval harness, started by GitHub Actions
// (.github/workflows/nightly-evals.yml) as a Nightly run of our test company's published config on the test host; its
// job fails when the run fails or can't run. The backend adds two alerts (error log → Sentry, M6-6) that don't depend on
// the job:
//   - reportFinishedRun: a Nightly run that finished without passing (EvalHarnessRepo.finish calls it after commit);
//   - checkRecentRun: the daily cron's check that the suite company (NIGHTLY_SUITE_COMPANY_ID, its public id; unset =
//     nothing to check, as on production) has a Nightly run that reached Done within Constants.NIGHTLY_SUITE_MAX_AGE_MS.
//     The company is looked up by public id in withPlatform (no company is known before it), its runs read in withTenant.
export default class NightlySuiteRepo {
  private env: Env;
  private db: NodePgDatabase;
  private companiesDal: CompaniesDAL;
  private evalRunsDal: EvalRunsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.companiesDal = new CompaniesDAL();
    this.evalRunsDal = new EvalRunsDAL();
  }

  // DEV_NOTE: Pure logging, no read: called with what the finish already knows
  static reportFinishedRun(params: {
    companyId: string;
    runPublicId: string;
    trigger: Schemas.EvalRunTriggerIntEnum;
    status: Schemas.EvalRunStatusIntEnum;
    hasPassed: boolean | null;
    caseCount: number | null;
    passAllKCount: number | null;
    failedSafetyCaseCount: number;
    failure: Schemas.EvalRunFailureIntEnum | null;
  }): void {
    if (params.trigger !== Schemas.EvalRunTriggerIntEnum.Nightly || params.hasPassed === true)
      return;
    const { trigger: _trigger, ...metadata } = params;
    AppLogger.error({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.ReportNightlyEvalRun,
      message:
        params.status === Schemas.EvalRunStatusIntEnum.Done
          ? "The nightly platform suite failed"
          : "The nightly platform suite didn't finish",
      metadata,
    });
  }

  async checkRecentRun(params: { now: Date }): Promise<Schemas.CheckNightlySuiteResponse> {
    const companyPublicId = this.env.NIGHTLY_SUITE_COMPANY_ID.trim();
    if (!companyPublicId) {
      return { isSuccess: true, message: "No nightly suite company in this env", isChecked: false };
    }
    const log = (message: string, metadata: Record<string, unknown> = {}) =>
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.CheckNightlySuite,
        message,
        metadata: { companyPublicId, ...metadata },
      });

    const company: Schemas.CompanyDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.companiesDal.getCompanyByPublicId(tx, { publicId: companyPublicId });
    });
    if (!company.isSuccess || !company.company) {
      const message = company.isNotFound
        ? "The nightly suite company doesn't exist"
        : "The nightly suite company couldn't be read";
      log(message);
      return { isSuccess: false, message };
    }
    const companyId = company.company.id;

    const latest: Schemas.EvalRunDALResponse = await withTenant(this.db, companyId, async (tx) => {
      return await this.evalRunsDal.getLatestDoneNightlyEvalRun(tx, { companyId });
    });
    if (!latest.isSuccess && !latest.isNotFound) {
      const message = "The nightly suite's runs couldn't be read";
      log(message);
      return { isSuccess: false, message };
    }
    const lastFinishedAt = latest.evalRun?.finishedAt ?? null;
    const isOverdue =
      lastFinishedAt === null ||
      params.now.getTime() - lastFinishedAt.getTime() > Constants.NIGHTLY_SUITE_MAX_AGE_MS;
    if (isOverdue) {
      log("The nightly platform suite hasn't finished a run lately", {
        lastFinishedAt: lastFinishedAt?.toISOString() ?? null,
      });
    }
    return {
      isSuccess: true,
      message: isOverdue ? "Nightly suite overdue" : "Nightly suite ran",
      isChecked: true,
      isOverdue,
      lastFinishedAt,
    };
  }
}
