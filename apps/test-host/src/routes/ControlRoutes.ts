import { Hono } from "hono";
import { TestHostWorkspaceDO } from "@/durable-objects/TestHostWorkspaceDO";
import { requireAdmin, validate } from "@/middlewares/AuthMiddleware";
import type AppContext from "@/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Fault control, mounted at /control, admin only: a test queues the next misbehaviours of a workspace
// (Schemas.ZTestHostFault) before driving the adapter, and can read back what is still queued.
const ControlRoutes = new Hono<AppContext>();

ControlRoutes.use("*", requireAdmin);

ControlRoutes.get(
  "/workspaces/:workspace/faults",
  validate("param", Schemas.ZTestHostWorkspaceParams),
  async (c) => {
    const workspace = TestHostWorkspaceDO.forWorkspace(c.env, c.req.valid("param").workspace);
    const faults: Schemas.TestHostSetFaultsRequest = { faults: await workspace.getFaults() };
    return c.json(faults, 200);
  },
);

ControlRoutes.put(
  "/workspaces/:workspace/faults",
  validate("param", Schemas.ZTestHostWorkspaceParams),
  validate("json", Schemas.ZTestHostSetFaultsRequest),
  async (c) => {
    const workspace = TestHostWorkspaceDO.forWorkspace(c.env, c.req.valid("param").workspace);
    const response = await workspace.setFaults(c.req.valid("json"));
    return c.json(response, response.isSuccess ? 200 : 400);
  },
);

export default ControlRoutes;
