import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import ChatbotConfigsRepo from "@/repositories/ChatbotConfigsRepo";
import ChatbotsRepo from "@/repositories/ChatbotsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Golden tenant routes, mounted at /dashboard/chatbots. Chain: checkAuth → authorizeCompany(action)
// → zValidator → handler. companyId comes from the signed-in admin (c.get("companyId")), never the client;
// chatbots are addressed by publicId. A write's audit row (M4-9) is relayed after the commit; its outbox ids never
// reach the client.
const ChatbotsRoutes = new Hono<AppContext>();

ChatbotsRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotRead),
  async (c) => {
    const repo = new ChatbotsRepo(c.env);
    const response = await repo.getChatbots({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

// DEV_NOTE: Settings › Bots' table (M4-10): live version and recent conversations per chatbot. Before "/:publicId".
ChatbotsRoutes.get(
  "/settings",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotRead),
  async (c) => {
    const repo = new ChatbotsRepo(c.env);
    const response = await repo.getChatbotSettingsRows({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

// DEV_NOTE: The Bots draft editor's pickers (M4-10), company-wide. Before "/:publicId".
ChatbotsRoutes.get(
  "/config-options",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigRead),
  async (c) => {
    const repo = new ChatbotConfigsRepo(c.env);
    const response = await repo.getChatbotConfigOptions({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

ChatbotsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotRead),
  async (c) => {
    const repo = new ChatbotsRepo(c.env);
    const response = await repo.getChatbotDetails({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ChatbotsRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotCreate),
  zValidator("json", Schemas.ZCreateChatbotApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotsRepo(c.env);
    const { outboxIds, ...response } = await repo.createChatbot({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 201 : 500);
  },
);

ChatbotsRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotUpdate),
  zValidator("json", Schemas.ZUpdateChatbotApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotsRepo(c.env);
    const { outboxIds, ...response } = await repo.updateChatbot({
      ...c.req.valid("json"),
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ChatbotsRoutes.post(
  "/:publicId/default",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotsRepo(c.env);
    const { outboxIds, ...response } = await repo.setDefaultChatbot({
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

export default ChatbotsRoutes;
