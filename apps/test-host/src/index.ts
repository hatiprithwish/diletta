import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import AuthRoutes from "@/routes/AuthRoutes";
import ControlRoutes from "@/routes/ControlRoutes";
import RecordsRoutes from "@/routes/RecordsRoutes";
import type AppContext from "@/AppContext";
import type * as Schemas from "@app/schemas";

export { TestHostWorkspaceDO } from "@/durable-objects/TestHostWorkspaceDO";

// DEV_NOTE: The test host (M3-3, docs/runbooks/test-host.md). Identity (/.well-known/jwks.json, /auth/tokens), the
// record API (/v1, the connection's base_url) and fault control (/control). Every error answers { error } as JSON with
// a fixed reason; nothing is logged beyond Workers' invocation logs.
const app = new Hono<AppContext>();

app.route("/", AuthRoutes);
app.route("/v1", RecordsRoutes);
app.route("/control", ControlRoutes);

app.notFound((c) => c.json({ error: "Not found" } satisfies Schemas.TestHostErrorBody, 404));

app.onError((error, c) => {
  // DEV_NOTE: e.g. a body that isn't JSON (400); anything else is the test host's own bug
  if (error instanceof HTTPException) {
    return c.json({ error: "Invalid request" } satisfies Schemas.TestHostErrorBody, error.status);
  }
  return c.json({ error: "Internal error" } satisfies Schemas.TestHostErrorBody, 500);
});

export default app;
