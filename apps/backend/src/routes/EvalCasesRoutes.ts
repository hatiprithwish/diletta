import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import EvalCasesRepo from "@/repositories/EvalCasesRepo";
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
    const repo = new EvalCasesRepo(c.env);
    const response = await repo.createEvalCase({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 201 : response.isNotFound ? 404 : 500);
  },
);

// DEV_NOTE: 409 = a refused edit (failure NotEditable: the stored conversation is a shape this page can't rewrite)
EvalCasesRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseUpdate),
  zValidator("json", Schemas.ZUpdateEvalCaseApiRequest),
  async (c) => {
    const repo = new EvalCasesRepo(c.env);
    const response = await repo.updateEvalCase({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    if (response.isSuccess) return c.json(response, 200);
    if (response.isNotFound) return c.json(response, 404);
    return c.json(response, response.failure ? 409 : 500);
  },
);

export default EvalCasesRoutes;
