import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanyConnectionsRepo from "@/repositories/CompanyConnectionsRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import TeamRepo from "@/repositories/TeamRepo";
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

function teamWriteStatus(response: Schemas.TeamWriteApiResponse, success: 200 | 201) {
  if (response.isSuccess) return success;
  if (response.failure) return Schemas.TEAM_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

function modelKeyWriteStatus(response: Schemas.ModelKeyWriteApiResponse, success: 200 | 201) {
  if (response.isSuccess) return success;
  if (response.failure) return Schemas.MODEL_KEY_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

SettingsRoutes.get(
  "/read-only",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigRead),
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

// DEV_NOTE: Settings › Connections (M4-10). Origins are edited through the Security route
// (PUT /dashboard/security/connections/:publicId/origins, ConnectionOriginsUpdate): one write path.
SettingsRoutes.get(
  "/connections",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ConnectionRead),
  async (c) => {
    const repo = new CompanyConnectionsRepo(c.env);
    const response = await repo.getSettingsConnections({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

// DEV_NOTE: Settings › Team (M4-10). Admins are addressed by their Clerk user id (admins carry no publicId), invites by
// publicId. Refusals answer TEAM_FAILURE_HTTP_STATUS_MAP (409 state, 502 Clerk).
SettingsRoutes.get(
  "/team",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.TeamRead),
  async (c) => {
    const repo = new TeamRepo(c.env);
    const response = await repo.getTeam({
      companyId: c.get("companyId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

SettingsRoutes.post(
  "/team/invites",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.TeamInvite),
  zValidator("json", Schemas.ZCreateAdminInviteApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new TeamRepo(c.env);
    const { outboxIds, ...response } = await repo.inviteAdmin({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, teamWriteStatus(response, 201));
  },
);

SettingsRoutes.post(
  "/team/invites/:publicId/revoke",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.TeamInviteRevoke),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new TeamRepo(c.env);
    const { outboxIds, ...response } = await repo.revokeInvite({
      companyId,
      adminId: c.get("admin").adminId,
      publicId: c.req.param("publicId"),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, teamWriteStatus(response, 200));
  },
);

SettingsRoutes.delete(
  "/team/admins/:clerkUserId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.TeamAdminRemove),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new TeamRepo(c.env);
    const { outboxIds, ...response } = await repo.removeAdmin({
      companyId,
      adminId: c.get("admin").adminId,
      clerkUserId: c.req.param("clerkUserId"),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, teamWriteStatus(response, 200));
  },
);

export default SettingsRoutes;
