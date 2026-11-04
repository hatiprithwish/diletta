import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizePlatform, resolveOperatorCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";
import { auditActorFor } from "@/repositories/audit";

// DEV_NOTE: Operator routes, mounted at /operator/companies. Chain: checkAuth → authorizePlatform(action)
// → (one company: resolveOperatorCompany, unknown → 404) → zValidator → handler. Creating and listing companies span
// every company, so CompaniesRepo runs them in withPlatform; one company's page and its status run in withTenant on
// it. A status change's audit row (actor Operator) is relayed after the commit; its outbox ids never reach the client.
const CompaniesRoutes = new Hono<AppContext>();

CompaniesRoutes.post(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyCreate),
  zValidator("json", Schemas.ZCreateCompanyApiRequest),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.createCompany(c.req.valid("json"));

    return c.json(response, response.isSuccess ? 201 : 500);
  },
);

CompaniesRoutes.get(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyList),
  zValidator("query", Schemas.ZGetCompaniesApiRequest),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getCompanies(c.req.valid("query"));

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

CompaniesRoutes.get(
  "/count",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyList),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getCompaniesCount();

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

// DEV_NOTE: M7-8. The Companies list's status tabs
CompaniesRoutes.get(
  "/status-counts",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyList),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getCompanyStatusCounts();

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

// DEV_NOTE: M7-8. One company's operator page. Registered after /count and /status-counts, which it would match.
CompaniesRoutes.get(
  "/:companyPublicId",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyRead),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getCompanyDetails({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

// DEV_NOTE: M7-8. Pause, churn or reactivate a company
CompaniesRoutes.patch(
  "/:companyPublicId/status",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyStatusUpdate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZUpdateCompanyStatusApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompaniesRepo(c.env);
    const { outboxIds, ...response } = await repo.updateCompanyStatus({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
      actor: auditActorFor(c.get("admin")),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default CompaniesRoutes;
