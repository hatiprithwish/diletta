import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import QualityIssuesRepo from "@/repositories/QualityIssuesRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Quality page (M4-6), mounted at /dashboard/quality-issues. Chain: checkAuth → authorizeCompany(action)
// → zValidator → handler. For the admin's company (c.get("companyId")); an issue is addressed by publicId. Reads:
// QualityIssueRead; triage, Mark fixed, Dismiss: QualityIssueUpdate; Create test (draft and save): EvalCaseCreate.
// /open-count is declared before /:publicId so it isn't read as an issue id.
const QualityIssuesRoutes = new Hono<AppContext>();

// DEV_NOTE: A write's answer: the event relayed after the commit (the outbox id never reaches the client), and its
// status: 200 with the issue as it stands, 404 unknown, 409 a refusal (failure: no longer Open, or no chatbot)
function answerWrite(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  companyId: string,
  result: Schemas.UpdateQualityIssueResponse,
): { response: Schemas.UpdateQualityIssueApiResponse; status: 200 | 404 | 409 | 500 } {
  const { outboxId, ...response } = result;
  if (outboxId) {
    ctx.waitUntil(new EventOutboxRepo(env).relayEvents({ companyId, outboxIds: [outboxId] }));
  }
  if (response.isSuccess) return { response, status: 200 };
  if (response.isNotFound) return { response, status: 404 };
  return { response, status: response.failure ? 409 : 500 };
}

// DEV_NOTE: Mark fixed and Dismiss: the same close, by path
const CLOSE_ROUTES: [path: string, status: Schemas.QualityIssueCloseStatus][] = [
  ["fix", Schemas.QualityIssueStatusIntEnum.Fixed],
  ["dismiss", Schemas.QualityIssueStatusIntEnum.Dismissed],
];

QualityIssuesRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.QualityIssueRead),
  zValidator("query", Schemas.ZGetQualityIssuesApiRequest),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const response = await repo.getQualityIssues({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

QualityIssuesRoutes.get(
  "/open-count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.QualityIssueRead),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const response = await repo.getOpenCount({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

QualityIssuesRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.QualityIssueRead),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const response = await repo.getQualityIssue({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

QualityIssuesRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.QualityIssueUpdate),
  zValidator("json", Schemas.ZTriageQualityIssueApiRequest),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const companyId = c.get("companyId");
    const result = await repo.triageQualityIssue({
      ...c.req.valid("json"),
      companyId,
      adminId: c.get("admin").adminId,
      publicId: c.req.param("publicId"),
    });
    const { response, status } = answerWrite(c.env, c.executionCtx, companyId, result);
    return c.json(response, status);
  },
);

for (const [path, status] of CLOSE_ROUTES) {
  QualityIssuesRoutes.post(
    `/:publicId/${path}`,
    checkAuth,
    authorizeCompany(Schemas.AuthzActionEnum.QualityIssueUpdate),
    async (c) => {
      const repo = new QualityIssuesRepo(c.env);
      const companyId = c.get("companyId");
      const result = await repo.closeQualityIssue({
        companyId,
        adminId: c.get("admin").adminId,
        publicId: c.req.param("publicId"),
        status,
      });
      const answer = answerWrite(c.env, c.executionCtx, companyId, result);
      return c.json(answer.response, answer.status);
    },
  );
}

// DEV_NOTE: A draft to review, saved nowhere. A refusal answers its failure's status
// (QUALITY_TEST_DRAFT_FAILURE_HTTP_STATUS_MAP); the model call's row is written in waitUntil.
QualityIssuesRoutes.post(
  "/:publicId/test-draft",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseCreate),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const response = await repo.draftQualityTest(
      { companyId: c.get("companyId"), publicId: c.req.param("publicId") },
      c.executionCtx,
    );

    if (response.isSuccess) return c.json(response, 200);
    if (response.isNotFound) return c.json(response, 404);
    if (response.failure) {
      return c.json(response, Schemas.QUALITY_TEST_DRAFT_FAILURE_HTTP_STATUS_MAP[response.failure]);
    }
    return c.json(response, 500);
  },
);

QualityIssuesRoutes.post(
  "/:publicId/convert",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.EvalCaseCreate),
  zValidator("json", Schemas.ZConvertQualityIssueApiRequest),
  async (c) => {
    const repo = new QualityIssuesRepo(c.env);
    const companyId = c.get("companyId");
    const result = await repo.convertQualityIssue({
      companyId,
      adminId: c.get("admin").adminId,
      publicId: c.req.param("publicId"),
      draft: c.req.valid("json"),
    });
    const { response, status } = answerWrite(c.env, c.executionCtx, companyId, result);
    return c.json(response, status);
  },
);

export default QualityIssuesRoutes;
