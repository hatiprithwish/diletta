import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import AuditLogRepo from "@/repositories/AuditLogRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Security page's audit log (M4-9), mounted at /dashboard/audit-log. Chain: checkAuth →
// authorizeCompany(AuditLogRead) → zValidator → handler. For the admin's company (c.get("companyId")); read-only.
const AuditLogRoutes = new Hono<AppContext>();

AuditLogRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.AuditLogRead),
  zValidator("query", Schemas.ZGetAuditLogApiRequest),
  async (c) => {
    const repo = new AuditLogRepo(c.env);
    const response = await repo.getAuditLog({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

AuditLogRoutes.get(
  "/count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.AuditLogRead),
  async (c) => {
    const repo = new AuditLogRepo(c.env);
    const response = await repo.getAuditLogCount({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

AuditLogRoutes.get(
  "/export",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.AuditLogRead),
  async (c) => {
    const repo = new AuditLogRepo(c.env);
    const response = await repo.exportAuditLog({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

export default AuditLogRoutes;
