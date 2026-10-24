import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import ChangeRequestsRepo from "@/repositories/ChangeRequestsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Changes page (M4-4 detail; M4-5 the list, timeline, needs-a-person count and Mark resolved), mounted at
// /dashboard/change-requests. Chain: checkAuth → authorizeCompany(action) → zValidator → handler. For the admin's
// company (c.get("companyId")); a change is addressed by publicId and never answered with its values. /needs-human-count
// is declared before /:publicId so it isn't read as a change id.
const ChangeRequestsRoutes = new Hono<AppContext>();

ChangeRequestsRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChangeRequestRead),
  zValidator("query", Schemas.ZGetChangeRequestsApiRequest),
  async (c) => {
    const repo = new ChangeRequestsRepo(c.env);
    const response = await repo.getChangeRequests({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ChangeRequestsRoutes.get(
  "/needs-human-count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChangeRequestRead),
  async (c) => {
    const repo = new ChangeRequestsRepo(c.env);
    const response = await repo.getNeedsHumanCount({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

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

// DEV_NOTE: 200 with the change as it stands after; 409 when it doesn't need a person (failure). The event is relayed
// after the commit; the outbox id never reaches the client.
ChangeRequestsRoutes.post(
  "/:publicId/resolve",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChangeRequestResolve),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChangeRequestsRepo(c.env);
    const { outboxId, ...response } = await repo.resolveChangeRequest({
      companyId,
      adminId: c.get("admin").adminId,
      publicId: c.req.param("publicId"),
    });
    if (outboxId) {
      c.executionCtx.waitUntil(
        new EventOutboxRepo(c.env).relayEvents({ companyId, outboxIds: [outboxId] }),
      );
    }

    if (response.isSuccess) return c.json(response, 200);
    if (response.isNotFound) return c.json(response, 404);
    return c.json(response, response.failure ? 409 : 500);
  },
);

export default ChangeRequestsRoutes;
