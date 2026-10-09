import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import KnowledgeSourcesRepo from "@/repositories/KnowledgeSourcesRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizeCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Knowledge sources and their documents (M2-5), mounted at /dashboard/knowledge-sources. Chain: checkAuth →
// authorizeCompany(action) → zValidator → handler. companyId comes from the signed-in admin, never the client; sources
// and documents are addressed by publicId. A request the source's state refuses (already syncing, paused, wrong source
// type) answers 409 with its failure; isSuccess ? 200 : isNotFound ? 404 : 500 otherwise.
const KnowledgeSourcesRoutes = new Hono<AppContext>();

function stateStatus(response: Schemas.KnowledgeSourceStateResponse, success: 200 | 201) {
  if (response.isSuccess) return success;
  if (response.failure) return 409;
  return response.isNotFound ? 404 : 500;
}

KnowledgeSourcesRoutes.get(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceRead),
  zValidator("query", Schemas.ZGetKnowledgeSourcesApiRequest),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.getKnowledgeSources({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

KnowledgeSourcesRoutes.get(
  "/count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceRead),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.getKnowledgeSourcesCount({ companyId: c.get("companyId") });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

KnowledgeSourcesRoutes.get(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceRead),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.getKnowledgeSourceDetails({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

KnowledgeSourcesRoutes.post(
  "/",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceCreate),
  zValidator("json", Schemas.ZCreateKnowledgeSourceApiRequest),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.createKnowledgeSource({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, response.isSuccess ? 201 : 500);
  },
);

KnowledgeSourcesRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceUpdate),
  zValidator("json", Schemas.ZUpdateKnowledgeSourceApiRequest),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.updateKnowledgeSource({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, stateStatus(response, 200));
  },
);

KnowledgeSourcesRoutes.delete(
  "/:publicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceDelete),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.deleteKnowledgeSource({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

KnowledgeSourcesRoutes.post(
  "/:publicId/sync",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceUpdate),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.startSync({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, stateStatus(response, 200));
  },
);

KnowledgeSourcesRoutes.get(
  "/:publicId/documents",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceRead),
  zValidator("query", Schemas.ZGetKnowledgeDocumentsApiRequest),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.getKnowledgeDocuments({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

KnowledgeSourcesRoutes.get(
  "/:publicId/documents/count",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceRead),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.getKnowledgeDocumentsCount({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

KnowledgeSourcesRoutes.post(
  "/:publicId/documents",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceUpdate),
  zValidator("form", Schemas.ZUploadKnowledgeDocumentApiRequest),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.uploadKnowledgeDocument({
      ...c.req.valid("form"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, stateStatus(response, 201));
  },
);

KnowledgeSourcesRoutes.delete(
  "/:publicId/documents/:documentPublicId",
  checkAuth,
  authorizeCompany(Schemas.AuthzActionEnum.KnowledgeSourceUpdate),
  async (c) => {
    const repo = new KnowledgeSourcesRepo(c.env);
    const response = await repo.deleteKnowledgeDocument({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      documentPublicId: c.req.param("documentPublicId"),
    });

    return c.json(response, stateStatus(response, 200));
  },
);

export default KnowledgeSourcesRoutes;
