import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import EvalCasesRepo from "@/repositories/EvalCasesRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Tests page's cases (M4-8), mounted at /dashboard/eval-cases. Chain: checkAuth → authorizeCompany(action)
// → zValidator → handler. For the admin's company (c.get("companyId")); a case is addressed by publicId. Reads:
// EvalCaseRead; New case: EvalCaseCreate; Edit and on / off: EvalCaseUpdate (the company's own cases only).
const EvalCasesRoutes = new Hono<AppContext>();

EvalCasesRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseRead),
  zValidator("query", Schemas.ZGetEvalCasesApiRequest),
  async (c) => {
    const repo = new EvalCasesRepo(c.env);
    const response = await repo.getEvalCases({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

EvalCasesRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseRead),
  async (c) => {
    const repo = new EvalCasesRepo(c.env);
    const response = await repo.getEvalCase({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

EvalCasesRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseCreate),
  zValidator("json", Schemas.ZCreateEvalCaseApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new EvalCasesRepo(c.env);
    const { outboxIds, ...response } = await repo.createEvalCase({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, response.isSuccess ? 201 : response.isNotFound ? 404 : 500);
  },
);

// DEV_NOTE: A refused edit answers its failure's status (EVAL_CASE_UPDATE_FAILURE_HTTP_STATUS_MAP: 409 NotEditable /
// NothingToCheck, 400 TooLong)
EvalCasesRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseUpdate),
  zValidator("json", Schemas.ZUpdateEvalCaseApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new EvalCasesRepo(c.env);
    const { outboxIds, ...response } = await repo.updateEvalCase({
      ...c.req.valid("json"),
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    if (response.isSuccess) return c.json(response, 200);
    if (response.isNotFound) return c.json(response, 404);
    return c.json(
      response,
      response.failure ? Schemas.EVAL_CASE_UPDATE_FAILURE_HTTP_STATUS_MAP[response.failure] : 500,
    );
  },
);

export default EvalCasesRoutes;
