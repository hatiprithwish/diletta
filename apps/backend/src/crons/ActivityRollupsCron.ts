import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import ActivityRollupsRepo from "@/repositories/ActivityRollupsRepo";

// DEV_NOTE: Hourly (CronScheduleProvider, at Constants.CRON_HOURLY_MINUTE, M4-2): rebuild today's and yesterday's
// activity_rollups (UTC) for every company that isn't churned. Goes through ActivityRollupsRepo, never a DAL (pattern
// rule 1.1). Every rebuild replaces its whole day, so a skipped tick is caught up by the next one; a day older than
// yesterday is rebuilt only by an operator (POST /operator/companies/:companyPublicId/rollups/rebuild).
export default async function runActivityRollups(env: Env): Promise<void> {
  const result = await new ActivityRollupsRepo(env).rebuildRecent();
  const log = {
    category: Schemas.LogCategory.Rollup,
    action: Schemas.LogAction.RebuildRecentActivityRollups,
    metadata: { rebuiltCount: result.rebuiltCount, failedCount: result.failedCount },
  };
  // DEV_NOTE: A failed run is an error even when nothing was attempted (the company list failed, incl. a withPlatform
  // transaction that never opened), so the runbook's alert keys on this one log
  if (result.isSuccess) {
    AppLogger.info({ ...log, message: result.message ?? "Activity rollups rebuilt" });
  } else {
    AppLogger.error({ ...log, message: result.message ?? "Activity rollups failed" });
  }
}
