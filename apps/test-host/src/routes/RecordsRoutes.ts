import { Hono, type Context } from "hono";
import { TestHostWorkspaceDO } from "@/durable-objects/TestHostWorkspaceDO";
import { requireHostToken, requireSigningKey, validate } from "@/middlewares/AuthMiddleware";
import type AppContext from "@/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The test host's REST API over records, mounted at /v1 (the connection's base_url). Chain: requireSigningKey
// → requireHostToken (the jwt_forward bearer; its ws claim picks the workspace) → validate → the workspace DO, which
// runs the request with its fault and its Idempotency-Key. Every answer is JSON { data } / { error }, or 204.
const RecordsRoutes = new Hono<AppContext>();

RecordsRoutes.use("*", requireSigningKey, requireHostToken);

// DEV_NOTE: Hands one request to the workspace and sends its answer. An Idempotency-Key header that isn't a valid key
// is refused (400) rather than ignored, so a write the caller means to be keyed never runs unkeyed.
async function runInWorkspace(
  c: Context<AppContext>,
  method: Schemas.ToolOpMethodEnum,
  operation: Schemas.TestHostOperation,
): Promise<Response> {
  const header = c.req.header(Schemas.HOST_IDEMPOTENCY_KEY_HEADER);
  if (header !== undefined && !Schemas.HOST_IDEMPOTENCY_KEY_PATTERN.test(header)) {
    return c.json({ error: "Invalid Idempotency-Key" } satisfies Schemas.TestHostErrorBody, 400);
  }

  const workspace = TestHostWorkspaceDO.forWorkspace(c.env, c.get("workspace"));
  const result = await workspace.run({
    method,
    path: c.req.path,
    idempotencyKey: header ?? null,
    operation,
  });

  if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));

  const headers = new Headers({ "Cache-Control": "no-store" });
  if (result.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(result.retryAfterSeconds));
  }
  if (result.body === null) return new Response(null, { status: result.status, headers });
  headers.set("Content-Type", "application/json");
  return new Response(result.body, { status: result.status, headers });
}

RecordsRoutes.get("/records", validate("query", Schemas.ZTestHostListRecordsQuery), (c) =>
  runInWorkspace(c, Schemas.ToolOpMethodEnum.Get, {
    kind: Schemas.TestHostOperationKindEnum.List,
    query: c.req.valid("query"),
  }),
);

RecordsRoutes.get("/records/:id", validate("param", Schemas.ZTestHostRecordParams), (c) =>
  runInWorkspace(c, Schemas.ToolOpMethodEnum.Get, {
    kind: Schemas.TestHostOperationKindEnum.Get,
    id: c.req.valid("param").id,
  }),
);

RecordsRoutes.post("/records", validate("json", Schemas.ZTestHostCreateRecordRequest), (c) =>
  runInWorkspace(c, Schemas.ToolOpMethodEnum.Post, {
    kind: Schemas.TestHostOperationKindEnum.Create,
    record: c.req.valid("json"),
  }),
);

RecordsRoutes.patch(
  "/records/:id",
  validate("param", Schemas.ZTestHostRecordParams),
  validate("json", Schemas.ZTestHostUpdateRecordRequest),
  (c) =>
    runInWorkspace(c, Schemas.ToolOpMethodEnum.Patch, {
      kind: Schemas.TestHostOperationKindEnum.Update,
      id: c.req.valid("param").id,
      fields: c.req.valid("json"),
    }),
);

RecordsRoutes.put(
  "/records/:id",
  validate("param", Schemas.ZTestHostRecordParams),
  validate("json", Schemas.ZTestHostCreateRecordRequest),
  (c) =>
    runInWorkspace(c, Schemas.ToolOpMethodEnum.Put, {
      kind: Schemas.TestHostOperationKindEnum.Put,
      id: c.req.valid("param").id,
      record: c.req.valid("json"),
    }),
);

RecordsRoutes.delete("/records/:id", validate("param", Schemas.ZTestHostRecordParams), (c) =>
  runInWorkspace(c, Schemas.ToolOpMethodEnum.Delete, {
    kind: Schemas.TestHostOperationKindEnum.Delete,
    id: c.req.valid("param").id,
  }),
);

// DEV_NOTE: The eval reset: the token's workspace back to TEST_HOST_SEED_RECORDS. The target of the connection's
// reset_op once the eval reset flow (M5-2) defines its shape; the seed leaves reset_op null until then.
RecordsRoutes.post("/_reset", (c) =>
  runInWorkspace(c, Schemas.ToolOpMethodEnum.Post, {
    kind: Schemas.TestHostOperationKindEnum.Reset,
  }),
);

export default RecordsRoutes;
