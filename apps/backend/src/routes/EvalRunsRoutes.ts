import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import EvalRunnerRepo from "@/repositories/EvalRunnerRepo";
import EvalRunsRepo from "@/repositories/EvalRunsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import { auditActorFor } from "@/repositories/audit";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Tests page's runs (M4-8), mounted at /dashboard/eval-runs. Chain: checkAuth → authorizeCompany(EvalRunRead)
// → zValidator → handler. For the admin's company (c.get("companyId")); a run is addressed by publicId, a case by its
// publicId, a transcript by its file's publicId. Runs start with the harness (M5-2) or, since M7-9 (ADR 0007), from POST /
// (authorizeCompany(EvalRunStart)): a Queued run handed to the hosted runner, refused with its
// EVAL_RUN_START_FAILURE_HTTP_STATUS_MAP status. /summary is declared before /:publicId so it isn't read as a run id.
const EvalRunsRoutes = new Hono<AppContext>();

EvalRunsRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunStart),
  zValidator("json", Schemas.ZStartEvalRunApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const admin = c.get("admin");
    const repo = new EvalRunnerRepo(c.env);
    const { outboxIds, ...response } = await repo.startRun({
      ...c.req.valid("json"),
      companyId,
      adminId: admin.adminId,
      actor: auditActorFor(admin),
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    if (response.isSuccess) return c.json(response, 201);
    if (response.failure) {
      return c.json(response, Schemas.EVAL_RUN_START_FAILURE_HTTP_STATUS_MAP[response.failure]);
    }
    return c.json(response, response.isNotFound ? 404 : 500);
  },
);

EvalRunsRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunRead),
  zValidator("query", Schemas.ZGetEvalRunsApiRequest),
  async (c) => {
    const repo = new EvalRunsRepo(c.env);
    const response = await repo.getEvalRuns({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

EvalRunsRoutes.get(
  "/summary",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunRead),
  zValidator("query", Schemas.ZGetEvalRunsSummaryApiRequest),
  async (c) => {
    const repo = new EvalRunsRepo(c.env);
    const response = await repo.getEvalRunsSummary({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

EvalRunsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunRead),
  async (c) => {
    const repo = new EvalRunsRepo(c.env);
    const response = await repo.getEvalRun({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

EvalRunsRoutes.get(
  "/:publicId/cases",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunRead),
  zValidator("query", Schemas.ZGetEvalRunCasesApiRequest),
  async (c) => {
    const repo = new EvalRunsRepo(c.env);
    const response = await repo.getEvalRunCases({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

EvalRunsRoutes.get(
  "/:publicId/cases/:casePublicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunRead),
  async (c) => {
    const repo = new EvalRunsRepo(c.env);
    const response = await repo.getEvalRunCase({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      casePublicId: c.req.param("casePublicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

// DEV_NOTE: The transcript parsed, never the raw file. A file that fails the parser answers its failure's status
// (EVAL_TRANSCRIPT_FAILURE_HTTP_STATUS_MAP).
EvalRunsRoutes.get(
  "/:publicId/transcripts/:filePublicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalRunRead),
  async (c) => {
    const repo = new EvalRunsRepo(c.env);
    const response = await repo.getEvalRunTranscript({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      filePublicId: c.req.param("filePublicId"),
    });

    if (response.isSuccess) return c.json(response, 200);
    if (response.isNotFound) return c.json(response, 404);
    if (response.failure) {
      return c.json(response, Schemas.EVAL_TRANSCRIPT_FAILURE_HTTP_STATUS_MAP[response.failure]);
    }
    return c.json(response, 500);
  },
);

export default EvalRunsRoutes;
