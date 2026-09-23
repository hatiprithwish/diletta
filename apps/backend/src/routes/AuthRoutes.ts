import { Hono } from "hono";
import checkAuth from "@/middlewares/AuthMiddleware";
import type AppContext from "@/config/AppContext";
import ClerkProvider from "@/providers/clerk";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

const AuthRoutes = new Hono<AppContext>();

AuthRoutes.post("/sign-out", checkAuth, async (c) => {
  const sessionId = c.get("clerkSessionId");
  const userId = c.get("clerkUserId");

  try {
    const clerk = ClerkProvider.getClerkClient(c.env);
    await clerk.sessions.revokeSession(sessionId);

    AppLogger.info({
      category: Schemas.LogCategory.Route,
      action: Schemas.LogAction.SignOut,
      message: "Session revoked",
      metadata: { userId, sessionId },
    });

    return c.json({ isSuccess: true }, 200);
  } catch (error) {
    AppLogger.error({
      category: Schemas.LogCategory.Route,
      action: Schemas.LogAction.SignOut,
      message: "Failed to revoke session",
      error,
      metadata: { userId, sessionId },
    });
    return c.json({ isSuccess: false, message: "Sign out failed" }, 500);
  }
});

export default AuthRoutes;
