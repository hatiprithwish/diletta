import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import KnowledgeSourcesRepo from "@/repositories/KnowledgeSourcesRepo";

// DEV_NOTE: Hourly (wrangler.jsonc triggers): starts a sync for every Active web source whose frequency is due (Daily
// after 24h, Weekly after 7 days, never synced yet) and re-claims a sync that went quiet past KNOWLEDGE_SYNC_STALE_MS.
// Goes through KnowledgeSourcesRepo, never a DAL (pattern rule 1.1). Failures are logged by the Repo and DAL; the next
// run retries.
export default async function runKnowledgeResync(env: Env): Promise<void> {
  const repo = new KnowledgeSourcesRepo(env);

  const result = await repo.startDueSyncs({ companyIds: null });
  if (result.startedCount || result.failedCount) {
    AppLogger.info({
      category: Schemas.LogCategory.Knowledge,
      action: Schemas.LogAction.StartDueKnowledgeSyncs,
      message: result.message ?? "Due knowledge syncs started",
      metadata: { startedCount: result.startedCount, failedCount: result.failedCount },
    });
  }
}
