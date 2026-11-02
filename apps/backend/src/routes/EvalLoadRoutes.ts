import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import authenticateEval from "@/middlewares/EvalAuthMiddleware";
import requireLoadCompany from "@/middlewares/LoadTestMiddleware";
import EvalLoadRepo from "@/repositories/EvalLoadRepo";
import type AppContext from "@/config/AppContext";
import type { EvalVariables } from "@/config/AppContext";
import * as Schemas from "@app/schemas";

type EvalContext = AppContext & { Variables: EvalVariables };

// DEV_NOTE: The load test's API (M6-5), mounted at /eval/load. Chain: authenticateEval (platform-signed eval JWT, an
// active Staging connection only) → requireLoadCompany (the load test company only) → zValidator → handler. The harness
// starts a window, drives its chats, and reads the summary; the contention routes hold and release budget without a
// user. Staging only by construction: production has no LOAD_TEST_COMPANY_ID, and an eval token never names a
// production connection.
const EvalLoadRoutes = new Hono<EvalContext>();

const SERVER_ERROR_BODY_STATUS = 500;

EvalLoadRoutes.post("/window", authenticateEval, requireLoadCompany, async (c) => {
  const result = await new EvalLoadRepo(c.env).startWindow({ identity: c.get("evalIdentity") });
  if (!result.isSuccess || !result.startedAt || !result.budget) {
    return c.json(
      {
        isSuccess: false,
        message: result.message,
        failure: Schemas.EvalRunStepFailureEnum.ServerError,
      },
      SERVER_ERROR_BODY_STATUS,
    );
  }
  const response: Schemas.EvalLoadWindowApiResponse = {
    isSuccess: true,
    message: result.message ?? "Load window started",
    startedAt: result.startedAt,
    budget: result.budget,
  };
  return c.json(response, 200);
});

EvalLoadRoutes.get(
  "/summary",
  authenticateEval,
  requireLoadCompany,
  zValidator("query", Schemas.ZEvalLoadSummaryApiRequest),
  async (c) => {
    const result = await new EvalLoadRepo(c.env).getSummary({
      identity: c.get("evalIdentity"),
      request: c.req.valid("query"),
    });
    if (
      !result.isSuccess ||
      !result.budget ||
      !result.timings ||
      result.timingsSince === undefined ||
      !result.modelCalls ||
      !result.outbox
    ) {
      return c.json(
        {
          isSuccess: false,
          message: result.message,
          failure: Schemas.EvalRunStepFailureEnum.ServerError,
        },
        SERVER_ERROR_BODY_STATUS,
      );
    }
    const response: Schemas.EvalLoadSummaryApiResponse = {
      isSuccess: true,
      message: result.message ?? "Load summary read",
      budget: result.budget,
      timings: result.timings,
      timingsSince: result.timingsSince,
      modelCalls: result.modelCalls,
      outbox: result.outbox,
    };
    return c.json(response, 200);
  },
);

EvalLoadRoutes.post(
  "/reserve",
  authenticateEval,
  requireLoadCompany,
  zValidator("json", Schemas.ZEvalLoadReserveApiRequest),
  async (c) => {
    const result = await new EvalLoadRepo(c.env).reserve({
      identity: c.get("evalIdentity"),
      request: c.req.valid("json"),
    });
    if (!result.isSuccess || result.isAdmitted === undefined || result.serverMs === undefined) {
      return c.json(
        {
          isSuccess: false,
          message: result.message,
          failure: Schemas.EvalRunStepFailureEnum.ServerError,
        },
        SERVER_ERROR_BODY_STATUS,
      );
    }
    const response: Schemas.EvalLoadReserveApiResponse = {
      isSuccess: true,
      message: result.message ?? "Budget reserved",
      isAdmitted: result.isAdmitted,
      reservationId: result.reservationId,
      refusal: result.refusal,
      serverMs: result.serverMs,
    };
    return c.json(response, 200);
  },
);

EvalLoadRoutes.post(
  "/release",
  authenticateEval,
  requireLoadCompany,
  zValidator("json", Schemas.ZEvalLoadReleaseApiRequest),
  async (c) => {
    const result = await new EvalLoadRepo(c.env).release({
      identity: c.get("evalIdentity"),
      request: c.req.valid("json"),
    });
    if (!result.isSuccess || result.serverMs === undefined) {
      return c.json(
        {
          isSuccess: false,
          message: result.message,
          failure: Schemas.EvalRunStepFailureEnum.ServerError,
        },
        SERVER_ERROR_BODY_STATUS,
      );
    }
    const response: Schemas.EvalLoadReleaseApiResponse = {
      isSuccess: true,
      message: result.message ?? "Budget released",
      serverMs: result.serverMs,
    };
    return c.json(response, 200);
  },
);

export default EvalLoadRoutes;
