import { createMiddleware } from "hono/factory";
import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import TokenProvider from "@/providers/tokens";
import type AppContext from "@/AppContext";
import * as Schemas from "@app/schemas";

const encoder = new TextEncoder();

const errorBody = (error: string): Schemas.TestHostErrorBody => ({ error });

// DEV_NOTE: A missing or unreadable TEST_HOST_SIGNING_KEY is a deployment mistake: 503 on every route that needs it,
// never a token signed or checked with a bad key
export const requireSigningKey = createMiddleware<AppContext>(async (c, next) => {
  const key = TokenProvider.readSigningKey(c.env);
  if (!key) return c.json(errorBody("Test host isn't configured"), 503);
  c.set("signingKey", key);
  await next();
});

// DEV_NOTE: Token minting and fault control: X-Test-Host-Admin must equal TEST_HOST_ADMIN_SECRET, compared on SHA-256
// digests in constant time (equal lengths, so timingSafeEqual never throws or leaks the secret's length)
export const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const secret = c.env.TEST_HOST_ADMIN_SECRET;
  if (!secret) return c.json(errorBody("Test host isn't configured"), 503);

  const given = c.req.header(Schemas.TEST_HOST_ADMIN_HEADER) ?? "";
  const [givenDigest, secretDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  if (!crypto.subtle.timingSafeEqual(givenDigest, secretDigest)) {
    return c.json(errorBody("Unauthorized"), 401);
  }
  await next();
});

// DEV_NOTE: The record API: Authorization: Bearer <host token> (scheme in any case), verified against the test host's
// own key. Every failure is the same 401, which the adapter reads as TokenRejected.
export const requireHostToken = createMiddleware<AppContext>(async (c, next) => {
  const match = /^bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  const claims = match
    ? await TokenProvider.verifyHostToken(c.env, c.get("signingKey"), match[1]!)
    : null;
  if (!claims) {
    c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    return c.json(errorBody("Unauthorized"), 401);
  }
  c.set("workspace", claims.ws);
  c.set("sub", claims.sub);
  await next();
});

// DEV_NOTE: zValidator with the test host's error body: a request that doesn't parse is 400 { error }, never the
// validator's issue dump (which would echo the request body)
export const validate = <Target extends "json" | "query" | "param", Schema extends ZodType>(
  target: Target,
  schema: Schema,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json(errorBody("Invalid request"), 400);
  });
