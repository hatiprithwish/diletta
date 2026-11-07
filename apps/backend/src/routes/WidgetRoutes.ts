import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { getAgentByName } from "agents";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import FeedbackRepo from "@/repositories/FeedbackRepo";
import WidgetAuthRepo from "@/repositories/WidgetAuthRepo";
import WidgetBootstrapRepo from "@/repositories/WidgetBootstrapRepo";
import WidgetHistoryRepo from "@/repositories/WidgetHistoryRepo";
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
// GET /bootstrap (M2-7, ADR 0002): what the widget shows before a conversation exists. GET /conversations and
// /conversations/:publicId: the widget's history, the user's own chats with this chatbot. Same token, same
// WidgetAuthRepo checks, sent as Authorization: Bearer (still never in the URL); none of them creates anything.
const WidgetRoutes = new Hono<AppContext>();

const FAILURE_BODY: Record<Schemas.WidgetAuthFailureEnum, string> = {
  [Schemas.WidgetAuthFailureEnum.Unauthorized]: "Unauthorized",
  [Schemas.WidgetAuthFailureEnum.Forbidden]: "Forbidden",
  [Schemas.WidgetAuthFailureEnum.NotFound]: "Not found",
  [Schemas.WidgetAuthFailureEnum.ServerError]: "Server error",
};

// DEV_NOTE: Host pages call /bootstrap and the history routes cross-origin, and which origins may is per connection,
// known only once the token is verified. So CORS answers any origin, without credentials (no cookies; the token is
// the only credential), and the data itself is gated by WidgetAuthRepo: a token's connection must list the request's
// Origin, else 403 with a generic body.
const widgetCors = cors({
  origin: (origin) => origin,
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["Authorization"],
  maxAge: 600,
  credentials: false,
});
WidgetRoutes.use("/bootstrap", widgetCors);
WidgetRoutes.use("/conversations", widgetCors);
WidgetRoutes.use("/conversations/*", widgetCors);

// DEV_NOTE: The bearer scheme is case-insensitive (RFC 9110)
const BEARER = /^bearer\s+(.+)$/i;
const INVALID_REQUEST_BODY = "Invalid request";

const rejectWith = (c: Context<AppContext>, failure: Schemas.WidgetAuthFailureEnum) =>
  c.json(
    { isSuccess: false, message: FAILURE_BODY[failure] },
    Schemas.WIDGET_AUTH_FAILURE_HTTP_STATUS_MAP[failure],
  );

// DEV_NOTE: The HTTP routes' one gate: the companion JWT as Authorization: Bearer, through WidgetAuthRepo.authenticate.
// The request (query, path) is checked only after the token: without a valid token the answer is 401 whatever it
// says; a verified token with a bad request gets 400. Returns the identity and the parsed request, or the response
// to send.
async function authenticateBearer<T>(
  c: Context<AppContext>,
  parsed: { success: true; data: T } | { success: false },
  chatbotOf: (data: T) => string | undefined,
): Promise<{ identity: Schemas.WidgetIdentity; data: T } | { response: Response }> {
  const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1]?.trim() ?? "";
  if (!token) return { response: rejectWith(c, Schemas.WidgetAuthFailureEnum.Unauthorized) };

  const authenticated = await new WidgetAuthRepo(c.env).authenticate({
    token,
    origin: c.req.header("Origin") ?? null,
    chatbotPublicId: parsed.success ? (chatbotOf(parsed.data) ?? null) : null,
  });
  if (!parsed.success && authenticated.failure !== Schemas.WidgetAuthFailureEnum.Unauthorized) {
    return { response: c.json({ isSuccess: false, message: INVALID_REQUEST_BODY }, 400) };
  }
  if (!parsed.success || !authenticated.isSuccess || !authenticated.identity) {
    return {
      response: rejectWith(c, authenticated.failure ?? Schemas.WidgetAuthFailureEnum.ServerError),
    };
  }
  return { identity: authenticated.identity, data: parsed.data };
}

WidgetRoutes.get("/bootstrap", async (c) => {
  const gate = await authenticateBearer(
    c,
    Schemas.ZWidgetBootstrapApiRequest.safeParse(c.req.query()),
    (query) => query.chatbot,
  );
  if ("response" in gate) return gate.response;

  const result = await new WidgetBootstrapRepo(c.env).getBootstrap({ identity: gate.identity });
  if (!result.isSuccess || !result.bootstrap) {
    return rejectWith(c, result.failure ?? Schemas.WidgetAuthFailureEnum.ServerError);
  }
  const response: Schemas.WidgetBootstrapApiResponse = {
    isSuccess: true,
    message: result.message,
    bootstrap: result.bootstrap,
  };
  return c.json(response, 200);
});

// DEV_NOTE: The widget's history (Your chats): the signed-in host user's own chats with this chatbot, newest first, a
// page at a time. Reads only, like /bootstrap.
WidgetRoutes.get("/conversations", async (c) => {
  const gate = await authenticateBearer(
    c,
    Schemas.ZWidgetConversationsApiRequest.safeParse(c.req.query()),
    (query) => query.chatbot,
  );
  if ("response" in gate) return gate.response;

  const result = await new WidgetHistoryRepo(c.env).getConversations({
    identity: gate.identity,
    pageNo: gate.data.pageNo ?? null,
  });
  if (!result.isSuccess) return rejectWith(c, Schemas.WidgetAuthFailureEnum.ServerError);
  const response: Schemas.WidgetConversationsApiResponse = {
    isSuccess: true,
    message: result.message,
    conversations: result.conversations ?? [],
    totalRecords: result.totalRecords ?? 0,
  };
  return c.json(response, 200);
});

// DEV_NOTE: One of those chats read back (its messages and their sources). 404 for a chat that isn't this user's with
// this chatbot, whether it exists or not.
WidgetRoutes.get("/conversations/:publicId", async (c) => {
  const params = Schemas.ZWidgetConversationApiParams.safeParse({
    publicId: c.req.param("publicId"),
  });
  const query = Schemas.ZWidgetBootstrapApiRequest.safeParse(c.req.query());
  const gate = await authenticateBearer(
    c,
    params.success && query.success
      ? { success: true as const, data: { ...query.data, ...params.data } }
      : { success: false as const },
    (request) => request.chatbot,
  );
  if ("response" in gate) return gate.response;

  const result = await new WidgetHistoryRepo(c.env).getConversation({
    identity: gate.identity,
    publicId: gate.data.publicId,
  });
  if (!result.isSuccess || !result.conversation) {
    return rejectWith(
      c,
      result.isNotFound
        ? Schemas.WidgetAuthFailureEnum.NotFound
        : Schemas.WidgetAuthFailureEnum.ServerError,
    );
  }
  const response: Schemas.WidgetConversationApiResponse = {
    isSuccess: true,
    message: result.message,
    conversation: result.conversation,
  };
  return c.json(response, 200);
});

WidgetRoutes.get("/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ isSuccess: false, message: "Expected a WebSocket upgrade" }, 426);
  }

  const reject = (failure: Schemas.WidgetAuthFailureEnum) => rejectWith(c, failure);

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
