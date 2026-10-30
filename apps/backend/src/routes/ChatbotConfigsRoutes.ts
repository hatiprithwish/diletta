import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import ChatbotConfigsRepo from "@/repositories/ChatbotConfigsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Settings › Bots versions (M4-10), mounted at /dashboard/chatbots/:chatbotPublicId/configs. Chain: checkAuth →
// authorizeCompany(action) → zValidator → handler. The chatbot and the version are addressed by publicId, the version
// always within its chatbot (another chatbot's or company's → 404). A refused write answers its failure's
// CHATBOT_CONFIG_FAILURE_HTTP_STATUS_MAP status (409 state, 400 body); isSuccess ? 200 / 201 : isNotFound ? 404 : 500
// otherwise. A write's audit row is relayed after the commit; its outbox ids never reach the client.
const ChatbotConfigsRoutes = new Hono<AppContext>();

function writeStatus(response: Schemas.ChatbotConfigWriteApiResponse, success: 200 | 201) {
  if (response.isSuccess) return success;
  if (response.failure) return Schemas.CHATBOT_CONFIG_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

ChatbotConfigsRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigRead),
  zValidator("query", Schemas.ZGetChatbotConfigsApiRequest),
  async (c) => {
    const repo = new ChatbotConfigsRepo(c.env);
    const response = await repo.getChatbotConfigs({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ChatbotConfigsRoutes.get(
  "/count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigRead),
  async (c) => {
    const repo = new ChatbotConfigsRepo(c.env);
    const response = await repo.getChatbotConfigsCount({
      companyId: c.get("companyId"),
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ChatbotConfigsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigRead),
  async (c) => {
    const repo = new ChatbotConfigsRepo(c.env);
    const response = await repo.getChatbotConfigDetails({
      companyId: c.get("companyId"),
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

// New draft from the editor's body
ChatbotConfigsRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigUpdate),
  zValidator("json", Schemas.ZSaveChatbotConfigApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.createChatbotConfig({
      ...c.req.valid("json"),
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 201));
  },
);

// Rollback as copy: the version's body into a new draft
ChatbotConfigsRoutes.post(
  "/:publicId/copy",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.copyChatbotConfig({
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 201));
  },
);

ChatbotConfigsRoutes.put(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigUpdate),
  zValidator("json", Schemas.ZSaveChatbotConfigApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.saveChatbotConfigDraft({
      ...c.req.valid("json"),
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 200));
  },
);

ChatbotConfigsRoutes.post(
  "/:publicId/discard",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.discardChatbotConfigDraft({
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 200));
  },
);

// The gate (M5-4): a draft goes to testing; its gate run's finish makes it Ready or a draft again
ChatbotConfigsRoutes.post(
  "/:publicId/send-to-testing",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.sendChatbotConfigToTesting({
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 200));
  },
);

ChatbotConfigsRoutes.post(
  "/:publicId/back-to-draft",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.moveChatbotConfigToDraft({
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 200));
  },
);

// Only a Ready version, on its passed gate run
ChatbotConfigsRoutes.post(
  "/:publicId/publish",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotConfigPublish),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new ChatbotConfigsRepo(c.env);
    const { outboxIds, ...response } = await repo.publishChatbotConfig({
      companyId,
      chatbotPublicId: c.req.param("chatbotPublicId") ?? "",
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response, 200));
  },
);

export default ChatbotConfigsRoutes;
