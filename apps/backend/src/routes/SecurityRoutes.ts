import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanyConnectionsRepo from "@/repositories/CompanyConnectionsRepo";
import CompanyEncryptionKeysRepo from "@/repositories/CompanyEncryptionKeysRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import QualityIssuesRepo from "@/repositories/QualityIssuesRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Security page (M4-9), mounted at /dashboard/security (the audit log is /dashboard/audit-log). Chain:
// checkAuth → authorizeCompany(action) → zValidator → handler. For the admin's company (c.get("companyId")); a connection
// is addressed by publicId. Reads: SecurityRead. Writes (each with its audit row, relayed after the commit; outbox ids
// never reach the client): allowed origins (ConnectionOriginsUpdate), Rotate key (EncryptionKeyRotate, 409 while a
// rotation is in progress), retention (RetentionUpdate).
const SecurityRoutes = new Hono<AppContext>();

SecurityRoutes.get(
  "/connections",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.SecurityRead),
  async (c) => {
    const repo = new CompanyConnectionsRepo(c.env);
    const response = await repo.getSecurityConnections({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

SecurityRoutes.put(
  "/connections/:publicId/origins",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ConnectionOriginsUpdate),
  zValidator("json", Schemas.ZUpdateAllowedOriginsApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanyConnectionsRepo(c.env);
    const { outboxIds, ...response } = await repo.updateAllowedOrigins({
      ...c.req.valid("json"),
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

SecurityRoutes.get(
  "/encryption-keys",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.SecurityRead),
  async (c) => {
    const repo = new CompanyEncryptionKeysRepo(c.env);
    const response = await repo.getSecurityEncryptionKeys({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

SecurityRoutes.post(
  "/encryption-keys/rotate",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EncryptionKeyRotate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanyEncryptionKeysRepo(c.env);
    const { outboxIds, ...response } = await repo.rotateFromDashboard({
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    if (response.isSuccess) return c.json(response, 200);
    return c.json(response, response.failure ? 409 : 500);
  },
);

SecurityRoutes.get(
  "/retention",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.SecurityRead),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getContentRetention({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

SecurityRoutes.put(
  "/retention",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.RetentionUpdate),
  zValidator("json", Schemas.ZUpdateContentRetentionApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompaniesRepo(c.env);
    const { outboxIds, ...response } = await repo.updateContentRetention({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

SecurityRoutes.get(
  "/injection-events",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.SecurityRead),
  zValidator("query", Schemas.ZGetInjectionEventsApiRequest),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const response = await repo.getInjectionEvents({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

SecurityRoutes.get(
  "/injection-events/count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.SecurityRead),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const response = await repo.getInjectionEventsCount({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

export default SecurityRoutes;
