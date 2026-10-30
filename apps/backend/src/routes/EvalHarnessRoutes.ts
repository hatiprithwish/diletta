import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import authenticateEval from "@/middlewares/EvalAuthMiddleware";
import EvalHarnessRepo from "@/repositories/EvalHarnessRepo";
import EvalJudgeRepo from "@/repositories/EvalJudgeRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import type AppContext from "@/config/AppContext";
import type { EvalVariables } from "@/config/AppContext";
import * as Schemas from "@app/schemas";

type EvalContext = AppContext & { Variables: EvalVariables };

// DEV_NOTE: The eval harness's API (M5-2), mounted at /eval. Chain: authenticateEval (platform-signed eval JWT, an
// active Staging connection only) → zValidator → handler. Never Clerk, never a dashboard route: the harness is platform
// code, and the company and connection come from the token, never a body. Every id in a path or body is a public id.
// The host token for the calls that reach the host (an attempt, a readback, the reset) comes in X-Host-Token and is
// handed straight to EvalHarnessRepo: never logged, stored or echoed.
const EvalHarnessRoutes = new Hono<EvalContext>();

const HOST_TOKEN_REQUIRED = { isSuccess: false, message: "Host token required" };

// DEV_NOTE: The harness's host bearer for this call; null when absent or too long
function hostTokenOf(c: Context<EvalContext>): string | null {
  const token = c.req.header(Schemas.EVAL_HOST_TOKEN_HEADER)?.trim() ?? "";
  return token.length > 0 && token.length <= Schemas.EVAL_HOST_TOKEN_MAX_LENGTH ? token : null;
}

function stepStatus(failure: Schemas.EvalRunStepFailureEnum | undefined) {
  return Schemas.EVAL_RUN_STEP_FAILURE_HTTP_STATUS_MAP[
    failure ?? Schemas.EvalRunStepFailureEnum.ServerError
  ];
}

EvalHarnessRoutes.post(
  "/runs",
  authenticateEval,
  zValidator("json", Schemas.ZCreateEvalRunApiRequest),
  async (c) => {
    const repo = new EvalHarnessRepo(c.env);
    const result = await repo.startRun({
      identity: c.get("evalIdentity"),
      request: c.req.valid("json"),
    });
    if (!result.isSuccess || !result.run || !result.cases) {
      return c.json(
        { isSuccess: false, message: result.message, failure: result.failure },
        stepStatus(result.failure),
      );
    }
    const response: Schemas.CreateEvalRunApiResponse = {
      isSuccess: true,
      message: result.message ?? "Eval run started",
      run: result.run,
      cases: result.cases,
    };
    return c.json(response, 201);
  },
);

EvalHarnessRoutes.post(
  "/runs/:runId/attempts",
  authenticateEval,
  zValidator("param", Schemas.ZEvalRunParam),
  zValidator("json", Schemas.ZRunEvalAttemptApiRequest),
  async (c) => {
    const hostToken = hostTokenOf(c);
    if (!hostToken) return c.json(HOST_TOKEN_REQUIRED, 400);
    const identity = c.get("evalIdentity");
    const result = await new EvalHarnessRepo(c.env).runAttempt({
      identity,
      runPublicId: c.req.valid("param").runId,
      request: c.req.valid("json"),
      hostToken,
    });
    const outboxIds = result.isSuccess || result.kind === "attempt" ? result.outboxIds : [];
    if (outboxIds.length > 0) {
      c.executionCtx.waitUntil(
        new EventOutboxRepo(c.env).relayEvents({ companyId: identity.companyId, outboxIds }),
      );
    }
    if (!result.isSuccess) {
      const status =
        result.kind === "step"
          ? stepStatus(result.failure)
          : Schemas.EVAL_ATTEMPT_FAILURE_HTTP_STATUS_MAP[result.failure];
      return c.json({ isSuccess: false, message: result.message, failure: result.failure }, status);
    }
    const response: Schemas.RunEvalAttemptApiResponse = {
      isSuccess: true,
      message: result.message,
      ...result.attempt,
    };
    return c.json(response, 200);
  },
);

EvalHarnessRoutes.post(
  "/runs/:runId/readbacks",
  authenticateEval,
  zValidator("param", Schemas.ZEvalRunParam),
  zValidator("json", Schemas.ZEvalReadbackApiRequest),
  async (c) => {
    const hostToken = hostTokenOf(c);
    if (!hostToken) return c.json(HOST_TOKEN_REQUIRED, 400);
    const result = await new EvalHarnessRepo(c.env).readBack({
      identity: c.get("evalIdentity"),
      runPublicId: c.req.valid("param").runId,
      request: c.req.valid("json"),
      hostToken,
    });
    if (!result.isSuccess || !result.check) {
      return c.json(
        { isSuccess: false, message: result.message, failure: result.failure },
        stepStatus(result.failure),
      );
    }
    const response: Schemas.EvalReadbackApiResponse = {
      isSuccess: true,
      message: result.message ?? "Record read back",
      ...result.check,
    };
    return c.json(response, 200);
  },
);

// DEV_NOTE: The pinned judge (M5-3), EvalJudgeRepo. No host token: it reads the attempt's transcript from its DO and
// calls the model router, never the host. JudgeUnavailable is 503.
EvalHarnessRoutes.post(
  "/runs/:runId/judge",
  authenticateEval,
  zValidator("param", Schemas.ZEvalRunParam),
  zValidator("json", Schemas.ZEvalJudgeApiRequest),
  async (c) => {
    const result = await new EvalJudgeRepo(c.env, c.executionCtx).judge({
      identity: c.get("evalIdentity"),
      runPublicId: c.req.valid("param").runId,
      request: c.req.valid("json"),
    });
    if (!result.isSuccess || !result.verdict) {
      return c.json(
        { isSuccess: false, message: result.message, failure: result.failure },
        stepStatus(result.failure),
      );
    }
    const response: Schemas.EvalJudgeApiResponse = {
      isSuccess: true,
      message: result.message ?? "Attempt judged",
      ...result.verdict,
    };
    return c.json(response, 200);
  },
);

EvalHarnessRoutes.post(
  "/runs/:runId/results",
  authenticateEval,
  zValidator("param", Schemas.ZEvalRunParam),
  zValidator("json", Schemas.ZRecordEvalResultApiRequest),
  async (c) => {
    const result = await new EvalHarnessRepo(c.env).recordResult({
      identity: c.get("evalIdentity"),
      runPublicId: c.req.valid("param").runId,
      request: c.req.valid("json"),
    });
    if (!result.isSuccess) {
      return c.json(
        { isSuccess: false, message: result.message, failure: result.failure },
        stepStatus(result.failure),
      );
    }
    const response: Schemas.RecordEvalResultApiResponse = {
      isSuccess: true,
      message: result.message ?? "Eval result recorded",
    };
    return c.json(response, 201);
  },
);

EvalHarnessRoutes.post(
  "/runs/:runId/reset",
  authenticateEval,
  zValidator("param", Schemas.ZEvalRunParam),
  async (c) => {
    const hostToken = hostTokenOf(c);
    if (!hostToken) return c.json(HOST_TOKEN_REQUIRED, 400);
    const result = await new EvalHarnessRepo(c.env).reset({
      identity: c.get("evalIdentity"),
      runPublicId: c.req.valid("param").runId,
      hostToken,
    });
    if (!result.isSuccess) {
      return c.json(
        { isSuccess: false, message: result.message, failure: result.failure },
        stepStatus(result.failure),
      );
    }
    const response: Schemas.ResetEvalRunApiResponse = {
      isSuccess: true,
      message: result.message ?? "Staging data reset",
      isReset: result.isReset ?? false,
    };
    return c.json(response, 200);
  },
);

EvalHarnessRoutes.post(
  "/runs/:runId/finish",
  authenticateEval,
  zValidator("param", Schemas.ZEvalRunParam),
  zValidator("json", Schemas.ZFinishEvalRunApiRequest),
  async (c) => {
    const result = await new EvalHarnessRepo(c.env).finish({
      identity: c.get("evalIdentity"),
      runPublicId: c.req.valid("param").runId,
      request: c.req.valid("json"),
    });
    if (!result.isSuccess || !result.run) {
      return c.json(
        { isSuccess: false, message: result.message, failure: result.failure },
        stepStatus(result.failure),
      );
    }
    const { run } = result;
    const response: Schemas.FinishEvalRunApiResponse = {
      isSuccess: true,
      message: result.message ?? "Eval run finished",
      status: run.status,
      statusLabel: Schemas.EVAL_RUN_STATUS_LABEL_MAP[run.status],
      caseCount: run.caseCount ?? 0,
      passAllKCount: run.passAllKCount ?? 0,
      hasPassed: run.hasPassed ?? false,
      costUsd: run.costUsd,
    };
    return c.json(response, 200);
  },
);

export default EvalHarnessRoutes;
