import { createMiddleware } from "hono/factory";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";
import ClerkProvider from "@/providers/clerk";
import type AppContext from "@/config/AppContext";

const checkAuth = createMiddleware<AppContext>(async (c, next) => {
  const clerk = ClerkProvider.getClerkClient(c.env);

  const allowedOrigins = c.env.ALLOWED_CORS_ORIGIN.split(",");
  const requestState = await clerk.authenticateRequest(c.req.raw, {
    authorizedParties: allowedOrigins,
  });

  if (!requestState.isSignedIn) {
    AppLogger.warn({
      category: Schemas.LogCategory.Middleware,
      action: Schemas.LogAction.VerifyToken,
      message: "Unauthenticated request",
      metadata: { reason: requestState.reason },
    });
    return c.json({ isSuccess: false, message: "Can't authorize request" }, 401);
  }

  const auth = requestState.toAuth();
  const claims = auth.sessionClaims as Record<string, unknown>;
  const email =
    typeof claims["email"] === "string"
      ? claims["email"]
      : typeof claims["email_address"] === "string"
        ? claims["email_address"]
        : typeof claims["primary_email_address"] === "string"
          ? claims["primary_email_address"]
          : "";

  c.set("clerkUserId", auth.userId!);
  c.set("clerkEmail", email);
  c.set("clerkSessionId", auth.sessionId!);

  AppLogger.info({
    category: Schemas.LogCategory.Middleware,
    action: Schemas.LogAction.VerifyToken,
    message: "Request authenticated",
    metadata: { userId: auth.userId },
  });

  await next();
});

export default checkAuth;
