import { createMiddleware } from "hono/factory";
import AppLogger from "@/providers/logger";
import type AppContext from "@/config/AppContext";
import type { EvalVariables } from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The second gate of /eval/load/* (M6-5), after authenticateEval: only the load test company, named by
// LOAD_TEST_COMPANY_ID (its public id; unset = no company, as on production and local). The eval token alone could name
// any company with a staging connection, and these routes hold budget and read a company's counters, so a token for
// another company is refused (403) however valid it is. The refusal body is generic; which check failed is logged.
const requireLoadCompany = createMiddleware<AppContext & { Variables: EvalVariables }>(
  async (c, next) => {
    const allowed = c.env.LOAD_TEST_COMPANY_ID.trim();
    const identity = c.get("evalIdentity");
    if (!allowed || identity.companyPublicId !== allowed) {
      AppLogger.warn({
        category: Schemas.LogCategory.LoadTest,
        action: Schemas.LogAction.AuthorizeLoadTest,
        message: allowed ? "Not the load test company" : "No load test company in this env",
        metadata: { companyPublicId: identity.companyPublicId },
      });
      return c.json(
        {
          isSuccess: false,
          message: "Forbidden",
          failure: Schemas.EvalAuthFailureEnum.Forbidden,
        },
        Schemas.EVAL_AUTH_FAILURE_HTTP_STATUS_MAP[Schemas.EvalAuthFailureEnum.Forbidden],
      );
    }
    await next();
  },
);

export default requireLoadCompany;
