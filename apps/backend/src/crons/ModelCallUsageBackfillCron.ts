import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import ModelCallsRepo from "@/repositories/ModelCallsRepo";

// DEV_NOTE: Every minute (wrangler.jsonc triggers, with the outbox sweep): fill Pending model_calls rows from their
// AI Gateway logs. Goes through ModelCallsRepo, never a DAL (pattern rule 1.1). Failures are logged by the Repo,
// provider and DAL; rows that stay Pending are retried next minute.
export default async function runModelCallUsageBackfill(env: Env): Promise<void> {
  const result = await new ModelCallsRepo(env).backfillPendingUsage({ companyIds: null });
  if (result.backfilledCount || result.unknownCount) {
    AppLogger.info({
      category: Schemas.LogCategory.ModelRouter,
      action: Schemas.LogAction.BackfillModelCallUsage,
      message: result.message ?? "Model call usage backfilled",
      metadata: {
        backfilledCount: result.backfilledCount,
        unknownCount: result.unknownCount,
        stillPendingCount: result.stillPendingCount,
      },
    });
  }
}
