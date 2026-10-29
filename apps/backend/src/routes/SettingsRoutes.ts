import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Settings pages' company-wide settings (M4-10), mounted at /dashboard/settings. Chain: checkAuth →
// authorizeCompany(action) → zValidator → handler. Read-only mode lives on the Bots page. A model key write refused by
// the provider check or the one-Active-key rule answers its MODEL_KEY_FAILURE_HTTP_STATUS_MAP status (400 / 502 / 409);
// isSuccess ? 200 / 201 : isNotFound ? 404 : 500 otherwise. A key's value is never in an answer. A write's audit row is
// relayed after the commit; its outbox ids never reach the client.
const SettingsRoutes = new Hono<AppContext>();

function modelKeyWriteStatus(response: Schemas.ModelKeyWriteApiResponse, success: 200 | 201) {
  if (response.isSuccess) return success;
  if (response.failure) return Schemas.MODEL_KEY_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

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

SettingsRoutes.get(
  "/model-keys",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ModelKeyRead),
  async (c) => {
    const repo = new CompanySecretsRepo(c.env);
    const response = await repo.getModelKeys({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

SettingsRoutes.post(
  "/model-keys",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ModelKeyUpdate),
  zValidator("json", Schemas.ZAddModelKeyApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanySecretsRepo(c.env);
    const { outboxIds, ...response } = await repo.addModelKey({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, modelKeyWriteStatus(response, 201));
  },
);

SettingsRoutes.post(
  "/model-keys/:publicId/rotate",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ModelKeyUpdate),
  zValidator("json", Schemas.ZRotateModelKeyApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompanySecretsRepo(c.env);
    const { outboxIds, ...response } = await repo.rotateModelKey({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
      publicId: c.req.param("publicId"),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, modelKeyWriteStatus(response, 200));
  },
);

SettingsRoutes.get(
  "/budget",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.BudgetRead),
  async (c) => {
    const repo = new CompaniesRepo(c.env);
    const response = await repo.getSpendingBudget({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

SettingsRoutes.put(
  "/budget",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.BudgetUpdate),
  zValidator("json", Schemas.ZUpdateSpendingBudgetApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new CompaniesRepo(c.env);
    const { outboxIds, ...response } = await repo.updateSpendingBudget({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default SettingsRoutes;
