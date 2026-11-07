import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import DashboardFeedbackThemesRepo from "@/repositories/DashboardFeedbackThemesRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";
import { auditActorFor } from "@/repositories/audit";

// DEV_NOTE: Quality › User feedback (M7-10), mounted at /dashboard/feedback-themes. Chain: checkAuth →
// authorizeCompany(action) → zValidator → handler. For the admin's company (c.get("companyId")); a theme is addressed by
// publicId. Reads: FeedbackThemeRead; Resolve and Dismiss: FeedbackThemeUpdate.
const FeedbackThemesRoutes = new Hono<AppContext>();

// DEV_NOTE: 200 with the theme as it stands, 404 unknown theme, 409 no longer Open
function writeStatus(response: Schemas.UpdateFeedbackThemeApiResponse) {
  if (response.isSuccess) return 200;
  if (response.isNotFound) return 404;
  return response.failure ? 409 : 500;
}

FeedbackThemesRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.FeedbackThemeRead),
  zValidator("query", Schemas.ZGetFeedbackThemesApiRequest),
  async (c) => {
    const repo = new DashboardFeedbackThemesRepo(c.env);
    const response = await repo.getFeedbackThemes({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

FeedbackThemesRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.FeedbackThemeRead),
  async (c) => {
    const repo = new DashboardFeedbackThemesRepo(c.env);
    const response = await repo.getFeedbackTheme({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

FeedbackThemesRoutes.post(
  "/:publicId/resolve",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.FeedbackThemeUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new DashboardFeedbackThemesRepo(c.env);
    const { outboxIds, ...response } = await repo.resolveFeedbackTheme({
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
      actor: auditActorFor(c.get("admin")),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response));
  },
);

FeedbackThemesRoutes.post(
  "/:publicId/dismiss",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.FeedbackThemeUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new DashboardFeedbackThemesRepo(c.env);
    const { outboxIds, ...response } = await repo.dismissFeedbackTheme({
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
      actor: auditActorFor(c.get("admin")),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response));
  },
);

export default FeedbackThemesRoutes;
