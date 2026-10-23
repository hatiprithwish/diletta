import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import RoiAssumptionsRepo from "@/repositories/RoiAssumptionsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Impact's minutes per task (M4-3), mounted at /dashboard/roi-assumptions. Chain: checkAuth →
// authorizeCompany(RoiAssumptionUpdate) → zValidator → handler. A save is a new row in force from today; an unknown
// tool is 404.
const RoiAssumptionsRoutes = new Hono<AppContext>();

RoiAssumptionsRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.RoiAssumptionUpdate),
  zValidator("json", Schemas.ZCreateRoiAssumptionApiRequest),
  async (c) => {
    const repo = new RoiAssumptionsRepo(c.env);
    const response = await repo.createRoiAssumption({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, response.isSuccess ? 201 : response.isNotFound ? 404 : 500);
  },
);

export default RoiAssumptionsRoutes;
