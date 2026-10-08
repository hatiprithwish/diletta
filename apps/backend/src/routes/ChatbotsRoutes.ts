import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import ChatbotsRepo from "@/repositories/ChatbotsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Golden tenant routes, mounted at /dashboard/chatbots. Chain: checkAuth → authorizeCompany(action)
// → zValidator → handler. companyId comes from the signed-in admin (c.get("companyId")), never the client;
// chatbots are addressed by publicId.
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

    return c.json(response, response.isSuccess ? 200 : 404);
  },
);

ChatbotsRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotCreate),
  zValidator("json", Schemas.ZCreateChatbotApiRequest),
  async (c) => {
    const repo = new ChatbotsRepo(c.env);
    const response = await repo.createChatbot({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 201 : 500);
  },
);

ChatbotsRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.ChatbotUpdate),
  zValidator("json", Schemas.ZUpdateChatbotApiRequest),
  async (c) => {
    const repo = new ChatbotsRepo(c.env);
    const response = await repo.updateChatbot({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : 404);
  },
);

export default ChatbotsRoutes;
