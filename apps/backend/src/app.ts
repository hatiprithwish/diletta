import { honoLogger } from "@logtape/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import AppLogger, { configureLogger, withRequestContext } from "@/providers/logger";
import AuthRoutes from "@/routes/AuthRoutes";
import AdminsRoutes from "@/routes/AdminsRoutes";
import ActivityRollupsRoutes from "@/routes/ActivityRollupsRoutes";
import ChangeRequestsRoutes from "@/routes/ChangeRequestsRoutes";
import ChatbotConfigsRoutes from "@/routes/ChatbotConfigsRoutes";
import ChatbotsRoutes from "@/routes/ChatbotsRoutes";
import SettingsRoutes from "@/routes/SettingsRoutes";
import CompaniesRoutes from "@/routes/CompaniesRoutes";
import ConversationsRoutes from "@/routes/ConversationsRoutes";
import DocGapClustersRoutes from "@/routes/DocGapClustersRoutes";
import EvalCasesRoutes from "@/routes/EvalCasesRoutes";
import EvalHarnessRoutes from "@/routes/EvalHarnessRoutes";
import EvalLoadRoutes from "@/routes/EvalLoadRoutes";
import AuditLogRoutes from "@/routes/AuditLogRoutes";
import SecurityRoutes from "@/routes/SecurityRoutes";
import EvalRunsRoutes from "@/routes/EvalRunsRoutes";
import InsightsRoutes from "@/routes/InsightsRoutes";
import KnowledgeSourcesRoutes from "@/routes/KnowledgeSourcesRoutes";
import QualityIssuesRoutes from "@/routes/QualityIssuesRoutes";
import RoiAssumptionsRoutes from "@/routes/RoiAssumptionsRoutes";
import ToolDefinitionsRoutes from "@/routes/ToolDefinitionsRoutes";
import CompanyConnectionsRoutes from "@/routes/CompanyConnectionsRoutes";
import WidgetRoutes from "@/routes/WidgetRoutes";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";

// DEV_NOTE: The worker's Hono app: every route, its middleware and onError. index.ts serves it as the worker's fetch;
// EvalRunnerEntrypoint serves its /eval/runs* to the hosted eval runner over the service binding (ADR 0007).
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
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "x-request-id",
          Schemas.ACTING_COMPANY_HEADER,
        ],
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

// DEV_NOTE: A handler that threw (M6-6): logged as an error (→ Sentry → the team channel) with the error reduced by
// toLoggableError, and answered with the shared 500 shape. Without it Hono prints the raw error to the console, where
// a query error's bound values would land.
app.onError((error, c) => {
  AppLogger.error({
    category: Schemas.LogCategory.Middleware,
    action: Schemas.LogAction.HandleUncaughtError,
    message: "Unhandled error in a route",
    error,
    metadata: { method: c.req.method, path: c.req.routePath },
  });
  return c.json({ isSuccess: false, message: "Something went wrong" }, 500);
});

app.route("/auth", AuthRoutes);
app.route("/dashboard", AdminsRoutes);
app.route("/dashboard/chatbots", ChatbotsRoutes);
app.route("/dashboard/chatbots/:chatbotPublicId/configs", ChatbotConfigsRoutes);
app.route("/dashboard/settings", SettingsRoutes);
app.route("/dashboard/knowledge-sources", KnowledgeSourcesRoutes);
app.route("/dashboard/doc-gap-clusters", DocGapClustersRoutes);
app.route("/dashboard/insights", InsightsRoutes);
app.route("/dashboard/roi-assumptions", RoiAssumptionsRoutes);
app.route("/dashboard/conversations", ConversationsRoutes);
app.route("/dashboard/change-requests", ChangeRequestsRoutes);
app.route("/dashboard/quality-issues", QualityIssuesRoutes);
app.route("/dashboard/eval-runs", EvalRunsRoutes);
app.route("/dashboard/eval-cases", EvalCasesRoutes);
app.route("/dashboard/audit-log", AuditLogRoutes);
app.route("/dashboard/security", SecurityRoutes);
app.route("/operator/companies", CompaniesRoutes);
app.route("/operator/companies/:companyPublicId/tool-definitions", ToolDefinitionsRoutes);
app.route("/operator/companies/:companyPublicId/connections", CompanyConnectionsRoutes);
app.route("/operator/companies/:companyPublicId/rollups", ActivityRollupsRoutes);
app.route("/widget", WidgetRoutes);
app.route("/eval", EvalHarnessRoutes);
app.route("/eval/load", EvalLoadRoutes);

export default app;
