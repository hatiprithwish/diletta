import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import KnowledgeIngestionRepo from "@/repositories/KnowledgeIngestionRepo";

// DEV_NOTE: An item step retries only on a throw (a crash or a lost connection); the Repo answers an expected failure
// (dead page, unsupported type, embedding refused) with outcome Failed and the sync goes on with the next item
const ITEM_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

// DEV_NOTE: One knowledge source sync (M2-5), started by KnowledgeSourcesRepo.startSync after it claimed the source
// (Syncing). Steps: list the items → one step per item (fetch or read, convert, hash, and only for a changed text chunk
// and embed) → prune pages gone from the sitemap (web) → finish (Active, or Failed when the listing failed or every
// item did). Every step goes through KnowledgeIngestionRepo; step results are small (ids, outcomes), never page text.
// A source paused or deleted mid-sync makes the next step answer Stopped, and the sync ends without finishing (the
// admin's state stays). An upload source lists again for files uploaded during the run, up to
// KNOWLEDGE_SYNC_MAX_ROUNDS rounds. If the run throws anyway, a last step marks the source Failed so it never sits in
// Syncing until KNOWLEDGE_SYNC_STALE_MS.
export class KnowledgeSyncWorkflow extends WorkflowEntrypoint<
  Env,
  Schemas.KnowledgeSyncWorkflowParams
> {
  async run(event: WorkflowEvent<Schemas.KnowledgeSyncWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const repo = new KnowledgeIngestionRepo(this.env);

    try {
      let succeededCount = 0;
      let failedCount = 0;
      let isListingFailed = false;

      for (let round = 0; round < Constants.KNOWLEDGE_SYNC_MAX_ROUNDS; round++) {
        const listed = await step.do(`list-${round}`, async () => {
          return await repo.listSyncItems({ ...params, round });
        });
        if (!listed.isSuccess) {
          isListingFailed = true;
          break;
        }
        if (listed.isStopped) return;
        const items = listed.items ?? [];

        for (const [index, item] of items.entries()) {
          const ingested = await step.do(`item-${round}-${index}`, ITEM_STEP_CONFIG, async () => {
            return await repo.ingestSyncItem({ ...params, item });
          });
          if (ingested.outcome === Schemas.KnowledgeSyncItemOutcomeEnum.Stopped) return;
          if (
            ingested.outcome === Schemas.KnowledgeSyncItemOutcomeEnum.Failed ||
            !ingested.isSuccess
          ) {
            failedCount++;
          } else {
            succeededCount++;
          }
        }

        if (listed.isWebSource) {
          const listedUrls = items.flatMap((item) => ("url" in item ? [item.url] : []));
          const pruned = await step.do("prune", async () => {
            return await repo.pruneUnlistedDocuments({ ...params, listedUrls });
          });
          if (!pruned.isSuccess) failedCount++;
          break;
        }
        if (items.length === 0) break;
      }

      const isFailed = isListingFailed || (succeededCount === 0 && failedCount > 0);
      await step.do("finish", async () => {
        return await repo.finishSync({ ...params, isFailed });
      });
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.RunKnowledgeSync,
        message: "Knowledge sync failed",
        error,
        metadata: params,
      });
      await step.do("finish-failed", async () => {
        return await repo.finishSync({ ...params, isFailed: true });
      });
      throw error;
    }
  }
}
