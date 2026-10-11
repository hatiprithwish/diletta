import { Hono } from "hono";
import TokenProvider from "@/providers/tokens";
import { requireAdmin, requireSigningKey, validate } from "@/middlewares/AuthMiddleware";
import type AppContext from "@/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The test host as an identity issuer, mounted at /. The JWKS is public (the platform fetches it from
// {iss}/.well-known/jwks.json); tokens are minted for the admin only, standing in for a real host's signed-in session.
const AuthRoutes = new Hono<AppContext>();

AuthRoutes.get("/.well-known/jwks.json", requireSigningKey, (c) => {
  const jwks: Schemas.TestHostJwks = { keys: [TokenProvider.getPublicJwk(c.get("signingKey"))] };
  c.header("Cache-Control", "public, max-age=300");
  return c.json(jwks, 200);
});

AuthRoutes.post(
  "/auth/tokens",
  requireAdmin,
  requireSigningKey,
  validate("json", Schemas.ZTestHostTokenRequest),
  async (c) => {
    const response = await TokenProvider.mint(c.env, c.get("signingKey"), c.req.valid("json"));
    c.header("Cache-Control", "no-store");
    return c.json(response, 201);
  },
);

export default AuthRoutes;
