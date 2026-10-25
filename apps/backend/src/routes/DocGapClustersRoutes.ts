import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import DocGapClustersRepo from "@/repositories/DocGapClustersRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Knowledge page's questions it couldn't answer (M4-7), mounted at /dashboard/doc-gap-clusters. Chain:
// checkAuth → authorizeCompany(action) → zValidator → handler. For the admin's company (c.get("companyId")); a group
// is addressed by publicId, its answering document by the document's publicId. Reads: DocGapClusterRead; Answer and
// Dismiss: DocGapClusterUpdate.
const DocGapClustersRoutes = new Hono<AppContext>();

// DEV_NOTE: 200 with the group as it stands, 404 unknown group or document, 409 no longer Open
function writeStatus(response: Schemas.UpdateDocGapClusterApiResponse) {
  if (response.isSuccess) return 200;
  if (response.isNotFound) return 404;
  return response.failure ? 409 : 500;
}

DocGapClustersRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.DocGapClusterRead),
  zValidator("query", Schemas.ZGetDocGapClustersApiRequest),
  async (c) => {
    const repo = new DocGapClustersRepo(c.env);
    const response = await repo.getDocGapClusters({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

DocGapClustersRoutes.post(
  "/:publicId/answer",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.DocGapClusterUpdate),
  zValidator("json", Schemas.ZAnswerDocGapClusterApiRequest),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new DocGapClustersRepo(c.env);
    const { outboxIds, ...response } = await repo.answerDocGapCluster({
      ...c.req.valid("json"),
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response));
  },
);

DocGapClustersRoutes.post(
  "/:publicId/dismiss",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.DocGapClusterUpdate),
  async (c) => {
    const companyId = c.get("companyId");
    const repo = new DocGapClustersRepo(c.env);
    const { outboxIds, ...response } = await repo.dismissDocGapCluster({
      companyId,
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });
    EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });

    return c.json(response, writeStatus(response));
  },
);

export default DocGapClustersRoutes;
