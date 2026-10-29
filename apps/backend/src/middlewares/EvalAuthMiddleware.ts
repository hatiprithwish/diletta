import { createMiddleware } from "hono/factory";
import EvalHarnessRepo from "@/repositories/EvalHarnessRepo";
import type AppContext from "@/config/AppContext";
import type { EvalVariables } from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The bearer scheme is case-insensitive (RFC 9110)
const BEARER = /^bearer\s+(.+)$/i;

const FAILURE_BODY: Record<Schemas.EvalAuthFailureEnum, string> = {
  [Schemas.EvalAuthFailureEnum.Unauthorized]: "Unauthorized",
  [Schemas.EvalAuthFailureEnum.Forbidden]: "Forbidden",
  [Schemas.EvalAuthFailureEnum.ServerError]: "Server error",
};

// DEV_NOTE: The only gate of /eval/* (M5-2): a platform-signed eval JWT as Authorization: Bearer, verified by
// EvalHarnessRepo.authenticate (signature, claims, then an active Staging connection of an active company). No Clerk
// session and no admin: the harness is platform code. A refusal is a generic body with the failure's status; which
// check failed is logged, never sent. Runs before any validator, so an unauthenticated call is 401 whatever its body.
const authenticateEval = createMiddleware<AppContext & { Variables: EvalVariables }>(
  async (c, next) => {
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1]?.trim() ?? "";
    const authenticated = token
      ? await new EvalHarnessRepo(c.env).authenticate(token)
      : { isSuccess: false, failure: Schemas.EvalAuthFailureEnum.Unauthorized };
    if (!authenticated.isSuccess || !("identity" in authenticated) || !authenticated.identity) {
      const failure = authenticated.failure ?? Schemas.EvalAuthFailureEnum.ServerError;
      return c.json(
        { isSuccess: false, message: FAILURE_BODY[failure], failure },
        Schemas.EVAL_AUTH_FAILURE_HTTP_STATUS_MAP[failure],
      );
    }
    c.set("evalIdentity", authenticated.identity);
    await next();
  },
);

export default authenticateEval;
