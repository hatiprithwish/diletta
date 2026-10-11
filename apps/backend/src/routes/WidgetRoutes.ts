import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAgentByName } from "agents";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import FeedbackRepo from "@/repositories/FeedbackRepo";
import WidgetAuthRepo from "@/repositories/WidgetAuthRepo";
import WidgetBootstrapRepo from "@/repositories/WidgetBootstrapRepo";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Widget routes, mounted at /widget. No Clerk session here: the widget proves who it is with the companion
// JWT, sent in Sec-WebSocket-Protocol on the upgrade (['diletta.v1', <jwt>]; never in the URL, which lands in logs).
// Everything is decided before any socket exists (ADR 0001): WidgetAuthRepo verifies the token, ConversationsRepo
// starts the user's conversation or checks the one they resume is theirs, and only then is the upgrade forwarded to
// that conversation's DO, with the verified session in a header this route always sets itself. A failure is an HTTP
// status with a generic body (401 / 403 / 404 / 500); which check failed is logged, never sent. The answer selects
// 'diletta.v1' only, so the token is never echoed.
//
// GET /bootstrap (M2-7, ADR 0002) is the one HTTP call: what the widget shows before a conversation exists. Same
// token, same WidgetAuthRepo checks, sent as Authorization: Bearer (still never in the URL); it creates nothing.
const WidgetRoutes = new Hono<AppContext>();

const FAILURE_BODY: Record<Schemas.WidgetAuthFailureEnum, string> = {
  [Schemas.WidgetAuthFailureEnum.Unauthorized]: "Unauthorized",
  [Schemas.WidgetAuthFailureEnum.Forbidden]: "Forbidden",
  [Schemas.WidgetAuthFailureEnum.NotFound]: "Not found",
  [Schemas.WidgetAuthFailureEnum.ServerError]: "Server error",
};

// DEV_NOTE: Host pages call /bootstrap cross-origin, and which origins may is per connection, known only once the token
// is verified. So CORS answers any origin, without credentials (no cookies; the token is the only credential), and
// the data itself is gated by WidgetAuthRepo: a token's connection must list the request's Origin, else 403 with a
// generic body.
WidgetRoutes.use(
  "/bootstrap",
  cors({
    origin: (origin) => origin,
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Authorization"],
    maxAge: 600,
    credentials: false,
  }),
);

// DEV_NOTE: The bearer scheme is case-insensitive (RFC 9110)
const BEARER = /^bearer\s+(.+)$/i;
const INVALID_REQUEST_BODY = "Invalid request";

WidgetRoutes.get("/bootstrap", async (c) => {
  const reject = (failure: Schemas.WidgetAuthFailureEnum) =>
    c.json(
      { isSuccess: false, message: FAILURE_BODY[failure] },
      Schemas.WIDGET_AUTH_FAILURE_HTTP_STATUS_MAP[failure],
    );

  const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1]?.trim() ?? "";
  if (!token) {
    return reject(Schemas.WidgetAuthFailureEnum.Unauthorized);
  }

  // DEV_NOTE: The query is checked only after the token (rule 3.22): without a valid token the answer is 401 whatever
  // the query says; a verified token with a bad query gets 400
  const query = Schemas.ZWidgetBootstrapApiRequest.safeParse(c.req.query());
  const authenticated = await new WidgetAuthRepo(c.env).authenticate({
    token,
    origin: c.req.header("Origin") ?? null,
    chatbotPublicId: query.success ? (query.data.chatbot ?? null) : null,
  });
  if (!query.success && authenticated.failure !== Schemas.WidgetAuthFailureEnum.Unauthorized) {
    return c.json({ isSuccess: false, message: INVALID_REQUEST_BODY }, 400);
  }
  if (!authenticated.isSuccess || !authenticated.identity) {
    return reject(authenticated.failure ?? Schemas.WidgetAuthFailureEnum.ServerError);
  }

  const result = await new WidgetBootstrapRepo(c.env).getBootstrap({
    identity: authenticated.identity,
  });
  if (!result.isSuccess || !result.bootstrap) {
    return reject(result.failure ?? Schemas.WidgetAuthFailureEnum.ServerError);
  }
  const response: Schemas.WidgetBootstrapApiResponse = {
    isSuccess: true,
    message: result.message,
    bootstrap: result.bootstrap,
  };
  return c.json(response, 200);
});

WidgetRoutes.get("/ws", async (c) => {
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

  // DEV_NOTE: The query is checked only after the token, as on /bootstrap
  const parsedQuery = Schemas.ZWidgetConnectApiRequest.safeParse(c.req.query());
  const authenticated = await new WidgetAuthRepo(c.env).authenticate({
    token,
    origin: c.req.header("Origin") ?? null,
    chatbotPublicId: parsedQuery.success ? (parsedQuery.data.chatbot ?? null) : null,
  });
  if (
    !parsedQuery.success &&
    authenticated.failure !== Schemas.WidgetAuthFailureEnum.Unauthorized
  ) {
    return c.json({ isSuccess: false, message: INVALID_REQUEST_BODY }, 400);
  }
  if (!parsedQuery.success || !authenticated.isSuccess || !authenticated.identity) {
    return reject(authenticated.failure ?? Schemas.WidgetAuthFailureEnum.ServerError);
  }
  const query = parsedQuery.data;

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

  // DEV_NOTE: A resumed conversation's ratings, for the widget's thumbs (a new one has none). A failed read sends none
  // rather than refusing the chat (logged by the DAL).
  const feedback = started.isNew
    ? []
    : ((await new FeedbackRepo(c.env).listConversationFeedback({ session })).ratings ?? []);

  try {
    // DEV_NOTE: A fresh header set: nothing the client sent beyond the upgrade itself reaches the DO, so it can't
    // pose as another session or pass its own session or feedback header
    const headers = new Headers({
      Upgrade: "websocket",
      Connection: "Upgrade",
      [Constants.CONVERSATION_SESSION_HEADER]: JSON.stringify(session),
      [Constants.CONVERSATION_FEEDBACK_HEADER]: JSON.stringify(feedback),
      [Constants.CONVERSATION_ROLES_HEADER]: JSON.stringify({
        roles: authenticated.identity.roles,
        expiresAt: authenticated.identity.tokenExpiresAt.getTime(),
      } satisfies Schemas.ConversationRolesGrant),
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
