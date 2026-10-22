import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import ChangeRequestPurgeRepo from "@/repositories/ChangeRequestPurgeRepo";

// DEV_NOTE: Every minute (M3-7): empty the values of change requests whose undo window ended. Goes through
// ChangeRequestPurgeRepo, never a DAL (pattern rule 1.1). Failures are logged by the DAL; the next run retries, so a
// missed tick only delays a purge by a minute.
export default async function runChangeRequestPurge(env: Env): Promise<void> {
  const purged = await new ChangeRequestPurgeRepo(env).purgeExpiredValues();
  if (purged.purgedCount) {
    AppLogger.info({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.PurgeChangeRequestValues,
      message: purged.message ?? "Change request values purged",
      metadata: { purgedCount: purged.purgedCount },
    });
  }
}
