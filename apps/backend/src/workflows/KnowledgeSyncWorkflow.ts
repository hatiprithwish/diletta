import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Constants from "@/config/Constants";
import KnowledgeIngestionRepo from "@/repositories/KnowledgeIngestionRepo";
import KnowledgeSourcesRepo from "@/repositories/KnowledgeSourcesRepo";

// DEV_NOTE: A step retries only when its callback throws. The Repo answers a database or storage failure with
// isSuccess false and the step throws (stepResult), so Workflows retries it; an expected failure (dead page,
// unsupported type, unreadable sitemap) is an outcome and needs no retry.
const STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};
// DEV_NOTE: Listing a sitemap reads up to KNOWLEDGE_SITEMAP_MAX_FILES files at KNOWLEDGE_FETCH_TIMEOUT_MS each
const LIST_STEP_CONFIG: WorkflowStepConfig = { ...STEP_CONFIG, timeout: "10 minutes" };

// DEV_NOTE: One knowledge source sync (M2-5), started by KnowledgeSourcesRepo.startSync after it claimed the source
// for this run (event.payload.syncRunId). Steps: list the items → one step per item (fetch or read, convert, hash, and
// only for a changed text chunk and embed) → prune pages gone from a complete sitemap listing (web) → finish (Active,
// or Failed when the listing failed or every item did) → start a follow-up sync if an upload source still has Pending
// files. Every step goes through a Repo; step results are small (ids, outcomes), never page text. A source paused,
// deleted or re-claimed by another run makes the next step answer Stopped, and this run ends without finishing. An
// upload source lists again for files uploaded during the run, up to KNOWLEDGE_SYNC_MAX_ROUNDS rounds. If the run
// throws anyway (a step out of retries), a last step marks the source Failed so it never sits in Syncing until the
// heartbeat goes stale.
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
        const listed = await step.do(`list-${round}`, LIST_STEP_CONFIG, async () => {
          return stepResult(await repo.listSyncItems({ ...params, round }));
        });
        if (listed.isStopped) return;
        if (listed.isListingFailed) {
          isListingFailed = true;
          break;
        }
        const items = listed.items ?? [];

        for (const [index, item] of items.entries()) {
          const ingested = await step.do(`item-${round}-${index}`, STEP_CONFIG, async () => {
            return stepResult(await repo.ingestSyncItem({ ...params, item }));
          });
          if (ingested.outcome === Schemas.KnowledgeSyncItemOutcomeEnum.Stopped) return;
          if (ingested.outcome === Schemas.KnowledgeSyncItemOutcomeEnum.Failed) {
            failedCount++;
          } else {
            succeededCount++;
          }
        }

        if (listed.isWebSource) {
          if (listed.isComplete) {
            const listedUrls = items.flatMap((item) => ("url" in item ? [item.url] : []));
            await step.do("prune", STEP_CONFIG, async () => {
              return stepResult(await repo.pruneUnlistedDocuments({ ...params, listedUrls }));
            });
          }
          break;
        }
        if (items.length === 0) break;
      }

      const isFailed = isListingFailed || (succeededCount === 0 && failedCount > 0);
      const finished = await step.do("finish", STEP_CONFIG, async () => {
        return stepResult(await repo.finishSync({ ...params, isFailed }));
      });
      if (finished.hasPendingDocuments) {
        await step.do("follow-up", STEP_CONFIG, async () => {
          const started = await new KnowledgeSourcesRepo(this.env).startSync({
            companyId: params.companyId,
            publicId: params.knowledgeSourcePublicId,
          });
          // DEV_NOTE: Refused for its state (paused, already syncing) = someone else will sync it; fine
          return stepResult(started.failure ? { ...started, isSuccess: true } : started);
        });
      }
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.RunKnowledgeSync,
        message: "Knowledge sync failed",
        error,
        metadata: params,
      });
      await step.do("finish-failed", STEP_CONFIG, async () => {
        return stepResult(await repo.finishSync({ ...params, isFailed: true }));
      });
      throw error;
    }
  }
}

// DEV_NOTE: A step's result as Workflows stores it, or a throw so the step is retried
function stepResult<T extends Schemas.ApiResponse>(result: T): T {
  if (!result.isSuccess) {
    throw new Error(result.message ?? "Knowledge sync step failed");
  }
  return result;
}
