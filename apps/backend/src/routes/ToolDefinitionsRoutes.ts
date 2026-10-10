import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import ToolDefinitionsRepo from "@/repositories/ToolDefinitionsRepo";
import checkAuth from "@/middlewares/AuthMiddleware";
import { authorizePlatform, resolveOperatorCompany } from "@/middlewares/AdminMiddleware";
import type AppContext from "@/config/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tool definitions (M3-1), operator routes mounted at /operator/companies/:companyPublicId/tool-definitions.
// Chain: checkAuth → authorizePlatform(action) → resolveOperatorCompany (unknown company → 404) → zValidator →
// handler. Operators curate a company's tools; a company admin gets 403. Tools are addressed by publicId. A refused request
// answers its failure's TOOL_DEFINITION_FAILURE_HTTP_STATUS_MAP status (409 state, 400 ops or connection); isSuccess ?
// 200 : isNotFound ? 404 : 500 otherwise.
const ToolDefinitionsRoutes = new Hono<AppContext>();

function stateStatus(response: Schemas.ToolDefinitionStateResponse, success: 200 | 201) {
  if (response.isSuccess) return success;
  if (response.failure) return Schemas.TOOL_DEFINITION_FAILURE_HTTP_STATUS_MAP[response.failure];
  return response.isNotFound ? 404 : 500;
}

ToolDefinitionsRoutes.get(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionRead),
  resolveOperatorCompany(),
  zValidator("query", Schemas.ZGetToolDefinitionsApiRequest),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.getToolDefinitions({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

ToolDefinitionsRoutes.get(
  "/count",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionRead),
  resolveOperatorCompany(),
  zValidator("query", Schemas.ZGetToolDefinitionsCountApiRequest),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.getToolDefinitionsCount({
      ...c.req.valid("query"),
      companyId: c.get("companyId"),
    });

    return c.json(response, response.isSuccess ? 200 : 500);
  },
);

ToolDefinitionsRoutes.get(
  "/:publicId",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionRead),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.getToolDefinitionDetails({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, response.isSuccess ? 200 : response.isNotFound ? 404 : 500);
  },
);

ToolDefinitionsRoutes.post(
  "/",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionCreate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZCreateToolDefinitionApiRequest),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.createToolDefinition({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, stateStatus(response, 201));
  },
);

ToolDefinitionsRoutes.patch(
  "/:publicId",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionUpdate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZUpdateToolDefinitionApiRequest),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.updateToolDefinition({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, stateStatus(response, 200));
  },
);

ToolDefinitionsRoutes.post(
  "/:publicId/versions",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionCreate),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.createToolDefinitionVersion({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, stateStatus(response, 201));
  },
);

ToolDefinitionsRoutes.put(
  "/:publicId/status",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionUpdate),
  resolveOperatorCompany(),
  zValidator("json", Schemas.ZSetToolDefinitionStatusApiRequest),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.setToolDefinitionStatus({
      ...c.req.valid("json"),
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
      adminId: c.get("admin").adminId,
    });

    return c.json(response, stateStatus(response, 200));
  },
);

ToolDefinitionsRoutes.delete(
  "/:publicId",
  checkAuth,
  authorizePlatform(Schemas.AuthzActionEnum.ToolDefinitionDelete),
  resolveOperatorCompany(),
  async (c) => {
    const repo = new ToolDefinitionsRepo(c.env);
    const response = await repo.deleteToolDefinition({
      companyId: c.get("companyId"),
      publicId: c.req.param("publicId"),
    });

    return c.json(response, stateStatus(response, 200));
  },
);

export default ToolDefinitionsRoutes;
