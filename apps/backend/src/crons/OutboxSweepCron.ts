import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";

// DEV_NOTE: Every minute (wrangler.jsonc triggers): publish the pending outbox rows the after-commit relay missed,
// then purge published rows past retention. Goes through EventOutboxRepo, never a DAL (pattern rule 1.1). Failures
// are logged by the Repo and DAL; the next run retries.
export default async function runOutboxSweep(env: Env): Promise<void> {
  const repo = new EventOutboxRepo(env);

  const swept = await repo.sweepPendingEvents({ companyIds: null });
  if (swept.publishedCount || swept.failedCount) {
    AppLogger.info({
      category: Schemas.LogCategory.Relay,
      action: Schemas.LogAction.SweepPendingEvents,
      message: swept.message ?? "Pending events swept",
      metadata: { publishedCount: swept.publishedCount, failedCount: swept.failedCount },
    });
  }

  const purged = await repo.purgePublishedEvents({ companyIds: null });
  if (purged.deletedCount) {
    AppLogger.info({
      category: Schemas.LogCategory.Relay,
      action: Schemas.LogAction.PurgePublishedEvents,
      message: purged.message ?? "Published events purged",
      metadata: { deletedCount: purged.deletedCount },
    });
  }
}
