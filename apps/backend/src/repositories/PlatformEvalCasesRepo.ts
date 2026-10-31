import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import PlatformEvalCaseSyncProvider from "@/providers/platformEvalCaseSync";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The platform suite's cases (M5-5): writes Schemas.PLATFORM_EVAL_CASES to eval_cases, run by the hourly
// PlatformEvalCaseSync cron, so a deploy reaches every environment's database without an owner connection. Platform
// cases belong to no company, so the sync runs in withPlatform (pattern rule 3.15), all in one transaction, under a
// lock so overlapping syncs take turns: a failed step rolls the whole sync back (TenantRollbackError) and the next hour
// retries it. PlatformEvalCaseSyncProvider.plan decides the writes; a safety case code removed or demoted stays as it is
// and the sync alerts (error log → Sentry, M6-6) until a migration retires it. A sync that changes nothing writes nothing.
// No audit row: no company owns these rows and no person made the change (the code review is the record). Case text stays
// out of every log.
//
// The scope is for tests only: they sync their own definitions over rows under their own key prefix, so running the suite
// never writes this checkout's real cases into the shared staging branch.
export default class PlatformEvalCasesRepo {
  private db: NodePgDatabase;
  private evalCasesDal: EvalCasesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.evalCasesDal = new EvalCasesDAL();
  }

  async sync(
    scope: { definitions: Schemas.PlatformEvalCaseDefinition[]; keyPrefix: string } | null = null,
  ): Promise<Schemas.SyncPlatformEvalCasesResponse> {
    const loaded = Schemas.loadPlatformEvalCases(scope?.definitions);
    if (!loaded.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.SyncPlatformEvalCases,
        message: loaded.message,
      });
      return { isSuccess: false, message: loaded.message };
    }

    const result: Schemas.SyncPlatformEvalCasesResponse = await withPlatform(
      this.db,
      async (tx) => {
        const locked = await this.evalCasesDal.lockPlatformEvalCases(tx);
        if (!locked.isSuccess) {
          throw new TenantRollbackError(locked.message ?? "Platform eval cases couldn't be locked");
        }
        const stored = await this.evalCasesDal.getPlatformEvalCases(tx);
        if (!stored.isSuccess || !stored.evalCases) {
          throw new TenantRollbackError(stored.message ?? "Platform eval cases couldn't be read");
        }
        const plan = PlatformEvalCaseSyncProvider.plan(
          scope
            ? stored.evalCases.filter((row) => row.platformKey?.startsWith(scope.keyPrefix))
            : stored.evalCases,
          loaded.cases,
        );

        for (const evalCase of plan.create) {
          const created = await this.evalCasesDal.createPlatformEvalCase(tx, evalCase);
          if (!created.isSuccess) {
            throw new TenantRollbackError(created.message ?? "A platform eval case wasn't created");
          }
        }
        for (const evalCase of plan.update) {
          const updated = await this.evalCasesDal.updatePlatformEvalCase(tx, evalCase);
          if (!updated.isSuccess) {
            throw new TenantRollbackError(updated.message ?? "A platform eval case wasn't updated");
          }
        }
        const deactivated = await this.evalCasesDal.deactivatePlatformEvalCases(tx, {
          ids: plan.deactivateIds,
        });
        if (!deactivated.isSuccess) {
          throw new TenantRollbackError(
            deactivated.message ?? "Platform eval cases weren't turned off",
          );
        }

        return {
          isSuccess: true,
          message: "Platform eval cases synced",
          createdCount: plan.create.length,
          updatedCount: plan.update.length,
          deactivatedCount: deactivated.changedCount ?? 0,
          keptSafetyKeys: plan.keptSafetyKeys,
        };
      },
    );

    const metadata = {
      createdCount: result.createdCount ?? 0,
      updatedCount: result.updatedCount ?? 0,
      deactivatedCount: result.deactivatedCount ?? 0,
    };
    if (!result.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.SyncPlatformEvalCases,
        message: result.message ?? "Platform eval cases weren't synced",
      });
      return result;
    }
    if (result.keptSafetyKeys && result.keptSafetyKeys.length > 0) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.SyncPlatformEvalCases,
        message: "Platform safety cases removed or demoted in code are still active",
        metadata: { ...metadata, keptSafetyKeys: result.keptSafetyKeys },
      });
    } else if (metadata.createdCount || metadata.updatedCount || metadata.deactivatedCount) {
      AppLogger.info({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.SyncPlatformEvalCases,
        message: "Platform eval cases synced",
        metadata,
      });
    }
    return result;
  }
}
