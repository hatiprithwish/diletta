import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Settings pages' company-wide settings (M4-10), mounted at /dashboard/settings. Chain: checkAuth →
// authorizeCompany(action) → zValidator → handler. Read-only mode lives on the Bots page. A write's audit row is relayed
// after the commit; its outbox ids never reach the client.
const SettingsRoutes = new Hono<AppContext>();

SettingsRoutes.get(
  "/read-only",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ReadOnlyModeRead),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getReadOnlyMode({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

SettingsRoutes.put(
  "/read-only",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ReadOnlyModeUpdate),
  zValidator("json", Schemas.ZUpdateReadOnlyModeApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompaniesRepo(c.env);
    const { outboxIds, ...response } = await repo.updateReadOnlyMode({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default SettingsRoutes;
