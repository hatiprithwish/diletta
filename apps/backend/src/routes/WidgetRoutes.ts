import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getAgentByName } from "agents";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import WidgetAuthRepo from "@/repositories/WidgetAuthRepo";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Widget routes, mounted at /widget. No Clerk session here: the widget proves who it is with the companion
// JWT, sent in Sec-WebSocket-Protocol on the upgrade (['diletta.v1', <jwt>]; never in the URL, which lands in logs).
// Everything is decided before any socket exists (ADR 0001): WidgetAuthRepo verifies the token, ConversationsRepo
// starts the user's conversation or checks the one they resume is theirs, and only then is the upgrade forwarded to
// that conversation's DO, with the verified session in a header this route always sets itself. A failure is an HTTP
// status with a generic body (401 / 403 / 404 / 500); which check failed is logged, never sent. The answer selects
// 'diletta.v1' only, so the token is never echoed.
const WidgetRoutes = new Hono<AppContext>();

const FAILURE_BODY: Record<Schemas.WidgetAuthFailureEnum, string> = {
  [Schemas.WidgetAuthFailureEnum.Unauthorized]: "Unauthorized",
  [Schemas.WidgetAuthFailureEnum.Forbidden]: "Forbidden",
  [Schemas.WidgetAuthFailureEnum.NotFound]: "Not found",
  [Schemas.WidgetAuthFailureEnum.ServerError]: "Server error",
};

WidgetRoutes.get("/ws", zValidator("query", Schemas.ZWidgetConnectApiRequest), async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ isSuccess: false, message: "Expected a WebSocket upgrade" }, 426);
  }

  const reject = (failure: Schemas.WidgetAuthFailureEnum) =>
    c.json(
      { isSuccess: false, message: FAILURE_BODY[failure] },
      Schemas.WIDGET_AUTH_FAILURE_HTTP_STATUS_MAP[failure],
    );

  // DEV_NOTE: The browser sends the offered subprotocols comma-separated; the token is the one that isn't ours
  const offered = (c.req.header("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  const token = offered.find((protocol) => protocol !== Schemas.WIDGET_SUBPROTOCOL);
  if (!offered.includes(Schemas.WIDGET_SUBPROTOCOL) || !token) {
    return reject(Schemas.WidgetAuthFailureEnum.Unauthorized);
  }

  const query = c.req.valid("query");
  const authenticated = await new WidgetAuthRepo(c.env).authenticate({
    token,
    origin: c.req.header("Origin") ?? null,
    chatbotPublicId: query.chatbot ?? null,
  });
  if (!authenticated.isSuccess || !authenticated.identity) {
    return reject(authenticated.failure ?? Schemas.WidgetAuthFailureEnum.ServerError);
  }

  const conversationsRepo = new ConversationsRepo(c.env);
  const started = await conversationsRepo.startOrResume({
    identity: authenticated.identity,
    conversationPublicId: query.conversation ?? null,
  });
  if (!started.isSuccess || !started.session) {
    return reject(
      Schemas.CONVERSATION_START_FAILURE_WIDGET_AUTH_MAP[
        started.failure ?? Schemas.ConversationStartFailureEnum.ServerError
      ],
    );
  }
  const { session } = started;
  if (started.outboxId) {
    c.executionCtx.waitUntil(
      new EventOutboxRepo(c.env).relayEvents({
        companyId: session.companyId,
        outboxIds: [started.outboxId],
      }),
    );
  }

  // DEV_NOTE: A conversation this request created but no socket ever reached would stay Open with no DO to auto-close
  // it, so it is closed again (Abandoned) when the upgrade fails
  const failUpgrade = async () => {
    if (started.isNew) {
      await conversationsRepo.closeConversation({
        session,
        outcome: Schemas.ConversationOutcomeIntEnum.Abandoned,
      });
    }
    return reject(Schemas.WidgetAuthFailureEnum.ServerError);
  };

  try {
    // DEV_NOTE: A fresh header set: nothing the client sent beyond the upgrade itself reaches the DO, so it can't
    // pose as another session or pass its own session header
    const headers = new Headers({
      Upgrade: "websocket",
      Connection: "Upgrade",
      [Constants.CONVERSATION_SESSION_HEADER]: JSON.stringify(session),
    });
    for (const name of ["Sec-WebSocket-Key", "Sec-WebSocket-Version", "Origin"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }

    const stub = await getAgentByName(c.env.CONVERSATION_DO, session.conversationPublicId);
    const upgraded = await stub.fetch(new Request(c.req.url, { headers }));
    if (upgraded.status !== 101 || !upgraded.webSocket) {
      AppLogger.error({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.StartConversation,
        message: "Conversation DO refused the upgrade",
        metadata: { conversationPublicId: session.conversationPublicId, status: upgraded.status },
      });
      return await failUpgrade();
    }

    return new Response(null, {
      status: 101,
      webSocket: upgraded.webSocket,
      headers: { "Sec-WebSocket-Protocol": Schemas.WIDGET_SUBPROTOCOL },
    });
  } catch (error) {
    AppLogger.error({
      category: Schemas.LogCategory.Conversation,
      action: Schemas.LogAction.StartConversation,
      message: "Unknown error in forwarding the widget upgrade",
      error,
      metadata: { conversationPublicId: session.conversationPublicId },
    });
    return await failUpgrade();
  }
});

export default WidgetRoutes;
