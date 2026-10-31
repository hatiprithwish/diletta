import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import DashboardConversationsRepo from "@/repositories/DashboardConversationsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import QualityIssuesRepo from "@/repositories/QualityIssuesRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Conversations page (M4-4), mounted at /dashboard/conversations. Chain: checkAuth →
// authorizeCompany(action) → zValidator → handler. Read-only for the admin's company (c.get("companyId")), except the
// flag, which opens an admin quality issue. Conversations are addressed by publicId; botId and configId are public ids
// too (unknown → 404). /export is declared before /:publicId so it isn't read as a conversation id.
const ConversationsRoutes = new Hono<AppContext>();

ConversationsRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ConversationRead),
  zValidator("query", Schemas.ZGetConversationsApiRequest),
  async (c) => {
    const repo = new DashboardConversationsRepo(c.env);
    const response = await repo.getConversations({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ConversationsRoutes.get(
  "/export",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ConversationRead),
  zValidator("query", Schemas.ZExportConversationsApiRequest),
  async (c) => {
    const repo = new DashboardConversationsRepo(c.env);
    const response = await repo.exportConversations({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ConversationsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ConversationRead),
  async (c) => {
    const repo = new DashboardConversationsRepo(c.env);
    const response = await repo.getConversation({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

// DEV_NOTE: 201 when the flag opened an issue, 200 when the conversation's admin issue was already open (nothing new).
// The issue's event is relayed after the commit; the outbox id never reaches the client.
ConversationsRoutes.post(
  "/:publicId/flag",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.QualityIssueCreate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new QualityIssuesRepo(c.env);
    const { outboxId, ...response } = await repo.flagConversation({
      companyId,
      adminId: c.get("admin").adminId,
      conversationPublicId: c.req.param("publicId"),
    });
    if (outboxId) {
      c.executionCtx.waitUntil(
        new EventOutboxRepo(c.env).relayEvents({ companyId, outboxIds: [outboxId] }),
      );
    }

    const successStatus = response.isCreated ? 201 : 200;
    return c.json(response, response.isSuccess ? successStatus : response.isNotFound ? 404 : 500);
  },
);

export default ConversationsRoutes;
