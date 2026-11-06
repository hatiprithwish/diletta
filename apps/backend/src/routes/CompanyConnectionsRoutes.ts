import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompanyConnectionsRepo from "@/repositories/CompanyConnectionsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizePlatform, resolveOperatorCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Company connections (M7-1), operator routes mounted at /operator/companies/:companyPublicId/connections.
// Chain: checkAuth → authorizePlatform(action) → resolveOperatorCompany (unknown company → 404) → zValidator →
// handler. Operators set up a host's connection (issuer, base URL, auth, origins, reset op); a company admin gets 403
// and edits only origins (Security page). Connections are addressed by publicId. A refused write answers its failure's
// COMPANY_CONNECTION_FAILURE_HTTP_STATUS_MAP status (409 issuer taken, 400 invalid); isSuccess ? 200 : isNotFound ?
// 404 : 500 otherwise. A write's audit rows (actor Operator) are relayed after the commit; their outbox ids never
// reach the client.
const CompanyConnectionsRoutes = new Hono<AppContext>();

function writeStatus(
  response: Schemas.CreateCompanyConnectionApiResponse & { isNotFound?: boolean },
  success: 200 | 201,
) {
  if (response.isSuccess) return success;
  if (response.failure) return Schemas.COMPANY_CONNECTION_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

CompanyConnectionsRoutes.get(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionRead),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new CompanyConnectionsRepo(c.env);
    const response = await repo.getCompanyConnections({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

CompanyConnectionsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionRead),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new CompanyConnectionsRepo(c.env);
    const response = await repo.getCompanyConnectionDetails({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

CompanyConnectionsRoutes.post(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionCreate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZCreateCompanyConnectionApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanyConnectionsRepo(c.env);
    const { outboxIds, ...response } = await repo.createCompanyConnection({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 201));
  },
);

CompanyConnectionsRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionUpdate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZUpdateCompanyConnectionApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanyConnectionsRepo(c.env);
    const { outboxIds, ...response } = await repo.updateCompanyConnection({
      ...c.req.valid("json"),
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 200));
  },
);

// DEV_NOTE: M7-9 (ADR 0007): a Staging connection's test sign-in for the hosted eval runner. GET answers which host and
// as whom (never the password or secret); PUT sets or replaces it whole (400 Invalid off Staging); DELETE revokes it.
// Each write records one audit row as the operator.
function loginStatus(response: Schemas.GetEvalHostLoginApiResponse) {
  if (response.isSuccess) return 200;
  if (response.failure) return Schemas.COMPANY_CONNECTION_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

CompanyConnectionsRoutes.get(
  "/:publicId/eval-login",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionRead),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new CompanyConnectionsRepo(c.env);
    const response = await repo.getEvalHostLogin({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, loginStatus(response));
  },
);

CompanyConnectionsRoutes.put(
  "/:publicId/eval-login",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionUpdate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZSetEvalHostLoginApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanyConnectionsRepo(c.env);
    const { outboxIds, ...response } = await repo.setEvalHostLogin({
      ...c.req.valid("json"),
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, loginStatus(response));
  },
);

CompanyConnectionsRoutes.delete(
  "/:publicId/eval-login",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.CompanyConnectionUpdate),
  resolveOperatorCompany(),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanyConnectionsRepo(c.env);
    const { outboxIds, ...response } = await repo.removeEvalHostLogin({
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, loginStatus(response));
  },
);

export default CompanyConnectionsRoutes;
