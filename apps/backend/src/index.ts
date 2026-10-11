import { honoLogger } from "@logtape/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import AppLogger, { configureLogger, disposeLogger, withRequestContext } from "@/providers/logger";
import AuthRoutes from "@/routes/AuthRoutes";
import AdminsRoutes from "@/routes/AdminsRoutes";
import ChatbotsRoutes from "@/routes/ChatbotsRoutes";
import CompaniesRoutes from "@/routes/CompaniesRoutes";
import KnowledgeSourcesRoutes from "@/routes/KnowledgeSourcesRoutes";
import ToolDefinitionsRoutes from "@/routes/ToolDefinitionsRoutes";
import WidgetRoutes from "@/routes/WidgetRoutes";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import runActivityLogPartitions from "@/crons/ActivityLogPartitionsCron";
import runKnowledgeResync from "@/crons/KnowledgeResyncCron";
import runModelCallUsageBackfill from "@/crons/ModelCallUsageBackfillCron";
import runOutboxSweep from "@/crons/OutboxSweepCron";
import CronScheduleProvider from "@/providers/cronSchedule";
import consumeEvents from "@/queues/EventsConsumer";

// DEV_NOTE: Durable Object classes are exported from the worker's main module (wrangler.jsonc durable_objects)
export { ConversationDO } from "@/durable-objects/ConversationDO";
export { BudgetDO } from "@/durable-objects/BudgetDO";
// DEV_NOTE: Workflow classes are exported from the main module too (wrangler.jsonc workflows)
export { KnowledgeSyncWorkflow } from "@/workflows/KnowledgeSyncWorkflow";

// DEV_NOTE: What each cron job runs; a Record, so a new CronJobEnum value can't be left without one
const CRON_JOBS: Record<Schemas.CronJobEnum, (env: Env) => Promise<void>> = {
  [Schemas.CronJobEnum.OutboxSweep]: runOutboxSweep,
  [Schemas.CronJobEnum.ModelCallUsageBackfill]: runModelCallUsageBackfill,
  [Schemas.CronJobEnum.KnowledgeResync]: runKnowledgeResync,
  [Schemas.CronJobEnum.ActivityLogPartitions]: runActivityLogPartitions,
};

// DEV_NOTE: Configure logger at the top level to ensure it's ready before handling any requests
await configureLogger();

const app = new Hono<{ Bindings: Env }>();

// DEV_NOTE: The dashboard's CORS (ALLOWED_CORS_ORIGIN, with credentials). /widget/* is called from host pages, whose
// origins are per connection (company_connections.allowed_origins), so WidgetRoutes sets its own.
app.use((c, next) =>
  c.req.path.startsWith("/widget/")
    ? next()
    : cors({
        origin: (origin) => {
          const allowed = c.env.ALLOWED_CORS_ORIGIN.split(",");
          return allowed.includes(origin) ? origin : null;
        },
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "x-request-id"],
        exposeHeaders: ["x-request-id"],
        maxAge: 7200,
        credentials: true,
      })(c, next),
);
app.use(requestId({ headerName: "x-request-id" }));

app.use(async (c, next) => {
  await withRequestContext(c.get("requestId"), next);
});

app.use(
  honoLogger({
    category: [Constants.APP_NAME, Schemas.LogCategory.Middleware],
    level: "info",
  }),
);

app.route("/auth", AuthRoutes);
app.route("/dashboard", AdminsRoutes);
app.route("/dashboard/chatbots", ChatbotsRoutes);
app.route("/dashboard/knowledge-sources", KnowledgeSourcesRoutes);
app.route("/operator/companies", CompaniesRoutes);
app.route("/operator/companies/:companyPublicId/tool-definitions", ToolDefinitionsRoutes);
app.route("/widget", WidgetRoutes);

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(disposeLogger());
    return app.fetch(req, env, ctx);
  },

  // DEV_NOTE: One cron trigger (Constants.CRON_TRIGGER, every minute); CronScheduleProvider picks the jobs due at its
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
      await Promise.allSettled(
        CronScheduleProvider.getDueJobs(controller.scheduledTime).map((job) => CRON_JOBS[job](env)),
      );
    }
    ctx.waitUntil(disposeLogger());
  },

  // DEV_NOTE: EVENTS_QUEUE consumer (the only queue this worker consumes)
  async queue(batch: MessageBatch<unknown>, _env: Env, ctx: ExecutionContext) {
    await consumeEvents(batch);
    ctx.waitUntil(disposeLogger());
  },
} satisfies ExportedHandler<Env>;
