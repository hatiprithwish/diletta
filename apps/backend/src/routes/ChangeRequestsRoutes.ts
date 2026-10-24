import { Hono } from "hono";
import ChangeRequestsRepo from "@/repositories/ChangeRequestsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Changes (M4-4 detail; M4-5 adds the list, timeline and resolve), mounted at /dashboard/change-requests.
// Chain: checkAuth → authorizeCompany(ChangeRequestRead) → handler. Read-only, for the admin's company; a change is
// addressed by publicId and never answered with its values.
const ChangeRequestsRoutes = new Hono<AppContext>();

ChangeRequestsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChangeRequestRead),
  async (c) => {
    const repo = new ChangeRequestsRepo(c.env);
    const response = await repo.getChangeRequest({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default ChangeRequestsRoutes;
