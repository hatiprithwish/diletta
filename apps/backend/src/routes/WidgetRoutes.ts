import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import WidgetAuthRepo from "@/repositories/WidgetAuthRepo";
import AppLogger from "@/providers/logger";
import Constants from "@/config/Constants";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Widget routes, mounted at /widget. There is no Clerk session here: the widget proves who it is in-band,
// with the companion JWT as its first WebSocket message (never in the URL, which lands in logs). The socket is
// accepted unauthenticated and closed unless its first message, sent within WIDGET_AUTH_TIMEOUT_MS, is a valid auth message.
// WidgetAuthRepo decides; this route only maps its failure to a close code. The widget gets the code and a generic
// reason, never which check failed. M2-2 moves the socket into the Conversation DO (routeAgentRequest), which runs
// the same WidgetAuthRepo.authenticate on the first message.
const WidgetRoutes = new Hono<AppContext>();

const CLOSE_REASON: Record<Schemas.WidgetCloseCodeEnum, string> = {
  [Schemas.WidgetCloseCodeEnum.BadRequest]: "Bad request",
  [Schemas.WidgetCloseCodeEnum.Unauthorized]: "Unauthorized",
  [Schemas.WidgetCloseCodeEnum.Forbidden]: "Forbidden",
  [Schemas.WidgetCloseCodeEnum.NotFound]: "Not found",
  [Schemas.WidgetCloseCodeEnum.AuthTimeout]: "Authentication timed out",
  [Schemas.WidgetCloseCodeEnum.ServerError]: "Server error",
};

WidgetRoutes.get("/ws", zValidator("query", Schemas.ZWidgetConnectApiRequest), async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ isSuccess: false, message: "Expected a WebSocket upgrade" }, 426);
  }

  const repo = new WidgetAuthRepo(c.env);
  const origin = c.req.header("Origin") ?? null;
  const chatbotPublicId = c.req.valid("query").chatbot ?? null;

  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();

  // DEV_NOTE: pending → verifying (first message in, checks running) → authenticated. Messages that arrive while the
  // first one is being verified get an error, not a second verification.
  let state: "pending" | "verifying" | "authenticated" | "closed" = "pending";

  // DEV_NOTE: The client can disconnect at any moment, including between a verification finishing and its close event
  // arriving, and send / close on a socket that is already closing throw. Both are guarded so they never throw into
  // the verification promise chain; a failed send means the socket is gone.
  const send = (message: Schemas.WidgetServerMessage) => {
    if (state === "closed") return;
    try {
      server.send(JSON.stringify(message));
    } catch {
      state = "closed";
      clearTimeout(authTimer);
    }
  };
  const close = (code: Schemas.WidgetCloseCodeEnum) => {
    if (state === "closed") return;
    state = "closed";
    clearTimeout(authTimer);
    try {
      server.close(code, CLOSE_REASON[code]);
    } catch {
      // DEV_NOTE: Already closing or closed by the client: nothing left to close
    }
  };

  // DEV_NOTE: Guards the first message only. Once it arrives the timer stops: verification is bounded by the JWKS
  // fetch timeout and the database, and ends in auth_ok or a close either way.
  const authTimer = setTimeout(() => {
    if (state === "pending") {
      AppLogger.warn({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.AuthenticateWidget,
        message: "No auth message in time",
        metadata: { origin },
      });
      close(Schemas.WidgetCloseCodeEnum.AuthTimeout);
    }
  }, Constants.WIDGET_AUTH_TIMEOUT_MS);

  server.addEventListener("message", (event) => {
    const parsed =
      typeof event.data === "string"
        ? Schemas.ZWidgetClientMessage.safeParse(parseJson(event.data))
        : null;

    if (state === "pending") {
      if (!parsed?.success || parsed.data.type !== "auth") {
        close(Schemas.WidgetCloseCodeEnum.BadRequest);
        return;
      }
      state = "verifying";
      clearTimeout(authTimer);
      const token = parsed.data.token;
      // DEV_NOTE: The listener can't be async (an unhandled rejection would be lost), so the verification runs as a
      // promise that never rejects: authenticate returns failures instead of throwing, and the catch covers the rest.
      repo
        .authenticate({ token, origin, chatbotPublicId })
        .then((result) => {
          if (state !== "verifying") return;
          if (!result.isSuccess || !result.identity) {
            close(
              Schemas.WIDGET_AUTH_FAILURE_CLOSE_CODE_MAP[
                result.failure ?? Schemas.WidgetAuthFailureEnum.ServerError
              ],
            );
            return;
          }
          state = "authenticated";
          send({
            type: "auth_ok",
            chatbot: {
              publicId: result.identity.chatbotPublicId,
              name: result.identity.chatbotName,
            },
          });
        })
        .catch((error: unknown) => {
          AppLogger.error({
            category: Schemas.LogCategory.Widget,
            action: Schemas.LogAction.AuthenticateWidget,
            message: "Unknown error in authenticating widget",
            error,
          });
          close(Schemas.WidgetCloseCodeEnum.ServerError);
        });
      return;
    }

    if (state === "verifying") {
      send({ type: "error", message: "Authentication in progress" });
      return;
    }

    if (state === "authenticated") {
      send({
        type: "error",
        message: parsed?.success ? "Already authenticated" : "Unsupported message",
      });
    }
  });

  server.addEventListener("close", () => {
    state = "closed";
    clearTimeout(authTimer);
  });

  return new Response(null, { status: 101, webSocket: client });
});

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default WidgetRoutes;
