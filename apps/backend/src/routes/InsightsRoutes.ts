import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import InsightsRepo from "@/repositories/InsightsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Insights pages (M4-3), mounted at /dashboard/insights. Chain: checkAuth → authorizeCompany(InsightRead)
// → zValidator("query") → handler. Read-only, from activity_rollups for the admin's company (c.get("companyId"));
// botId is a chatbot public id (absent = the whole company), an unknown one is 404.
const InsightsRoutes = new Hono<AppContext>();

InsightsRoutes.get(
  "/overview",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.InsightRead),
  zValidator("query", Schemas.ZGetInsightsApiRequest),
  async (c) => {
    const repo = new InsightsRepo(c.env);
    const response = await repo.getOverview({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

InsightsRoutes.get(
  "/usage",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.InsightRead),
  zValidator("query", Schemas.ZGetInsightsApiRequest),
  async (c) => {
    const repo = new InsightsRepo(c.env);
    const response = await repo.getUsage({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

InsightsRoutes.get(
  "/impact",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.InsightRead),
  zValidator("query", Schemas.ZGetImpactApiRequest),
  async (c) => {
    const repo = new InsightsRepo(c.env);
    const response = await repo.getImpact({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default InsightsRoutes;
