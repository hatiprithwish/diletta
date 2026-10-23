import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import ActivityRollupsRepo from "@/repositories/ActivityRollupsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizePlatform, resolveOperatorCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Activity rollups (M4-2), operator routes mounted at /operator/companies/:companyPublicId/rollups.
// Chain: checkAuth → authorizePlatform(action) → resolveOperatorCompany (unknown company → 404) → zValidator →
// handler. The hourly cron keeps today and yesterday current; this rebuilds any other range of one company's days (a
// fix in the sources, a backfill), each day in its own withTenant. A company admin gets 403. 200 when every day was
// rebuilt, 500 when any failed (the response lists which).
const ActivityRollupsRoutes = new Hono<AppContext>();

ActivityRollupsRoutes.post(
  "/rebuild",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ActivityRollupRebuild),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZRebuildActivityRollupsApiRequest),
  async (c) => {
    const repo = new ActivityRollupsRepo(c.env);
    const response = await repo.rebuildDays({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

export default ActivityRollupsRoutes;
