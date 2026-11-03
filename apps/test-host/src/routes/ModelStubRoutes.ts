import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { zValidator } from "@hono/zod-validator";
import ModelStubProvider from "@/providers/modelStub";
import type AppContext from "@/AppContext";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The stub model (M6-5, ADR 0005, docs/runbooks/load.md), mounted at Schemas.TEST_HOST_MODEL_STUB_PATH: the
// Anthropic Messages API, so the load test runs the platform's whole model path (router, budget, recording) without a
// provider. The backend's staging MODEL_BASE_URL_OVERRIDE points here, and only a company key that starts with
// LOAD_STUB_MODEL_KEY_PREFIX is sent. Errors are Anthropic's own shape, because the provider SDK reads them. The key and
// the request are never stored or logged.
const ModelStubRoutes = new Hono<AppContext>();

const anthropicError = (type: string, message: string) => ({
  type: "error",
  error: { type, message },
});

const requireStubKey = createMiddleware<AppContext>(async (c, next) => {
  if (!ModelStubProvider.isStubKey(c.req.header("x-api-key"))) {
    return c.json(anthropicError("authentication_error", "Invalid API key"), 401);
  }
  await next();
});

ModelStubRoutes.use("*", requireStubKey);

// DEV_NOTE: The model key check lists models; any stub key is valid
ModelStubRoutes.get("/models", (c) => c.json({ data: [], has_more: false }, 200));

ModelStubRoutes.post(
  "/messages",
  zValidator("json", Schemas.ZTestHostModelStubRequest, (result, c) => {
    if (!result.success) {
      return c.json(anthropicError("invalid_request_error", "Invalid request"), 400);
    }
  }),
  async (c) => {
    const { model, stream } = c.req.valid("json");
    if (!stream) {
      await new Promise((resolve) =>
        setTimeout(resolve, Schemas.TEST_HOST_MODEL_STUB_FIRST_TOKEN_DELAY_MS),
      );
      return c.json(ModelStubProvider.buildMessage(model), 200);
    }

    const encoder = new TextEncoder();
    const frames = ModelStubProvider.buildStream(model);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const { delayMs, frame } of frames) {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  },
);

export default ModelStubRoutes;
