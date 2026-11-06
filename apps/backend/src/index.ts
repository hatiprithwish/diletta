import * as Sentry from "@sentry/cloudflare";
import app from "@/app";
import AppLogger, { disposeLogger } from "@/providers/logger";
import SentryProvider from "@/providers/sentry";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import runActivityLogPartitions from "@/crons/ActivityLogPartitionsCron";
import runActivityRollups from "@/crons/ActivityRollupsCron";
import runChangeRequestPurge from "@/crons/ChangeRequestPurgeCron";
import runContentRetentionPurge from "@/crons/ContentRetentionPurgeCron";
import runChatbotHealthCheck from "@/crons/ChatbotHealthCron";
import runEvalTranscriptSweep from "@/crons/EvalTranscriptSweepCron";
import runKeyRotationSweep from "@/crons/KeyRotationSweepCron";
import runKnowledgeResync from "@/crons/KnowledgeResyncCron";
import runModelCallUsageBackfill from "@/crons/ModelCallUsageBackfillCron";
import runNightlySuiteCheck from "@/crons/NightlySuiteCheckCron";
import runOutboxSweep from "@/crons/OutboxSweepCron";
import runPlatformEvalCaseSync from "@/crons/PlatformEvalCaseSyncCron";
import CronScheduleProvider from "@/providers/cronSchedule";
import consumeEvents from "@/queues/EventsConsumer";

// DEV_NOTE: Durable Object classes are exported from the worker's main module (wrangler.jsonc durable_objects)
export { ConversationDO } from "@/durable-objects/ConversationDO";
export { BudgetDO } from "@/durable-objects/BudgetDO";
// DEV_NOTE: Workflow classes are exported from the main module too (wrangler.jsonc workflows)
export { KnowledgeSyncWorkflow } from "@/workflows/KnowledgeSyncWorkflow";
// DEV_NOTE: The hosted eval runner's service binding (M7-9, ADR 0007): a named WorkerEntrypoint, never a route
export { EvalRunnerEntrypoint } from "@/entrypoints/EvalRunnerEntrypoint";

// DEV_NOTE: What each cron job runs; a Record, so a new CronJobEnum value can't be left without one
const CRON_JOBS: Record<Schemas.CronJobEnum, (env: Env) => Promise<void>> = {
  [Schemas.CronJobEnum.OutboxSweep]: runOutboxSweep,
  [Schemas.CronJobEnum.ModelCallUsageBackfill]: runModelCallUsageBackfill,
  [Schemas.CronJobEnum.ChangeRequestPurge]: runChangeRequestPurge,
  [Schemas.CronJobEnum.KeyRotationSweep]: runKeyRotationSweep,
  [Schemas.CronJobEnum.KnowledgeResync]: runKnowledgeResync,
  [Schemas.CronJobEnum.ActivityRollups]: runActivityRollups,
  [Schemas.CronJobEnum.EvalTranscriptSweep]: runEvalTranscriptSweep,
  [Schemas.CronJobEnum.PlatformEvalCaseSync]: runPlatformEvalCaseSync,
  [Schemas.CronJobEnum.ContentRetentionPurge]: runContentRetentionPurge,
  [Schemas.CronJobEnum.ActivityLogPartitions]: runActivityLogPartitions,
  [Schemas.CronJobEnum.NightlySuiteCheck]: runNightlySuiteCheck,
  [Schemas.CronJobEnum.ChatbotHealthCheck]: runChatbotHealthCheck,
};

// DEV_NOTE: withSentry (M6-6) sends what escapes these handlers (not routes: onError above logs those) to Sentry,
// scrubbed by scrubSentryEvent. Off when SENTRY_DSN is empty. See providers/sentry.ts.
export default Sentry.withSentry((env: Env) => SentryProvider.workerOptions(env), {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(disposeLogger());
    return app.fetch(req, env, ctx);
  },

  // DEV_NOTE: One cron trigger (Constants.CRON_TRIGGER, every 15 minutes); CronScheduleProvider picks the jobs due at its
  // scheduled time. Jobs are independent: one failing never skips another (each logs its own failures).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron !== Constants.CRON_TRIGGER) {
      AppLogger.error({
        category: Schemas.LogCategory.Cron,
        action: Schemas.LogAction.DispatchCron,
        message: "No job for this cron expression",
        metadata: { cron: controller.cron },
      });
    } else {
      const jobs = CronScheduleProvider.getDueJobs(controller.scheduledTime);
      const results = await Promise.allSettled(jobs.map((job) => CRON_JOBS[job](env)));
      // DEV_NOTE: A job that threw (instead of logging its own failure) would otherwise vanish in allSettled
      results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        AppLogger.error({
          category: Schemas.LogCategory.Cron,
          action: Schemas.LogAction.DispatchCron,
          message: "Cron job threw",
          error: result.reason,
          metadata: { job: jobs[index] },
        });
      });
    }
    ctx.waitUntil(disposeLogger());
  },

  // DEV_NOTE: EVENTS_QUEUE consumer (the only queue this worker consumes)
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    await consumeEvents(batch, env, ctx);
    ctx.waitUntil(disposeLogger());
  },
} satisfies ExportedHandler<Env>);
