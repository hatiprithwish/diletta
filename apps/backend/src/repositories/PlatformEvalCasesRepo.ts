import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The platform suite's cases (M5-5): writes Schemas.PLATFORM_EVAL_CASES to eval_cases, run by the hourly
// PlatformEvalCaseSync cron, so a deploy reaches every environment's database without an owner connection. Platform
// cases belong to no company, so the sync runs in withPlatform (pattern rule 3.15), all in one transaction: a failed
// step rolls the whole sync back (TenantRollbackError) and the next hour retries it. Matched by platform_key:
//   - a key not stored yet → inserted, active;
//   - a stored key whose name, safety flag or bodies differ from the code (bodies compared through stableStringify,
//     since jsonb doesn't keep key order), or that is off → rewritten and turned on;
//   - a stored key no longer in code → turned off, unless it is a safety case: the CHECK keeps a platform safety case
//     active, so it stays and the sync alerts (error log → Sentry, M6-6) until a migration retires it.
// A sync that changes nothing writes nothing. No audit row: no company owns these rows and no person made the change (the
// code review is the record). Case text stays out of every log.
export default class PlatformEvalCasesRepo {
  private db: NodePgDatabase;
  private evalCasesDal: EvalCasesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.evalCasesDal = new EvalCasesDAL();
  }

  async sync(): Promise<Schemas.SyncPlatformEvalCasesResponse> {
    const loaded = Schemas.loadPlatformEvalCases();
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
        const stored = await this.evalCasesDal.getPlatformEvalCases(tx);
        if (!stored.isSuccess || !stored.evalCases) {
          throw new TenantRollbackError(stored.message ?? "Platform eval cases couldn't be read");
        }
        const storedByKey = new Map(
          stored.evalCases.flatMap((row) => (row.platformKey ? [[row.platformKey, row]] : [])),
        );

        let createdCount = 0;
        let updatedCount = 0;
        for (const evalCase of loaded.cases) {
          const row = storedByKey.get(evalCase.platformKey);
          if (!row) {
            const created = await this.evalCasesDal.createPlatformEvalCase(tx, evalCase);
            if (!created.isSuccess) {
              throw new TenantRollbackError(
                created.message ?? "A platform eval case wasn't created",
              );
            }
            createdCount++;
            continue;
          }
          const isSame =
            row.isActive &&
            row.name === evalCase.name &&
            row.isSafety === evalCase.isSafety &&
            Utility.stableStringify(row.input) === Utility.stableStringify(evalCase.input) &&
            Utility.stableStringify(row.expectations) ===
              Utility.stableStringify(evalCase.expectations);
          if (isSame) continue;
          const updated = await this.evalCasesDal.updatePlatformEvalCase(tx, {
            ...evalCase,
            id: row.id,
          });
          if (!updated.isSuccess) {
            throw new TenantRollbackError(updated.message ?? "A platform eval case wasn't updated");
          }
          updatedCount++;
        }

        const codeKeys = new Set(loaded.cases.map((evalCase) => evalCase.platformKey));
        const removed = stored.evalCases.filter(
          (row) => row.platformKey !== null && !codeKeys.has(row.platformKey) && row.isActive,
        );
        const keptSafetyKeys = removed.flatMap((row) =>
          row.isSafety && row.platformKey ? [row.platformKey] : [],
        );
        const deactivated = await this.evalCasesDal.deactivatePlatformEvalCases(tx, {
          ids: removed.filter((row) => !row.isSafety).map((row) => row.id),
        });
        if (!deactivated.isSuccess) {
          throw new TenantRollbackError(
            deactivated.message ?? "Platform eval cases weren't turned off",
          );
        }

        return {
          isSuccess: true,
          message: "Platform eval cases synced",
          createdCount,
          updatedCount,
          deactivatedCount: deactivated.changedCount ?? 0,
          keptSafetyKeys,
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
        message: "Platform safety cases no longer in code are still active",
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
