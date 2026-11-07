import { vi } from "vitest";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: A host's OpenAPI spec for tests (ADR 0009), built from tools' own bindings so every operation a tool sends
// exists in it: each tool's method and path become an operation (operationId = the tool's name), its query args become
// query parameters and its body map becomes the request body, every leaf a string unless a test overrides it. Served
// at SPEC_URL by serveSpec, which leaves every other fetch alone.
export const SPEC_URL = "https://host.example.com/api/openapi.json";

type Json = Record<string, unknown>;

function bodySchema(template: unknown): Json {
  if (Array.isArray(template)) return { type: "array", items: bodySchema(template[0]) };
  if (template !== null && typeof template === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(template).map(([key, value]) => [key, bodySchema(value)]),
      ),
    };
  }
  return { type: "string" };
}

export function specFor(
  tools: { name: string; ops: Pick<Schemas.ToolOpsInput, "callOp"> }[],
  overrides: (tool: string) => Json | undefined = () => undefined,
): Json {
  const paths: Record<string, Json> = {};
  for (const tool of tools) {
    const { method, path, query, bodyMap } = tool.ops.callOp;
    const specPath = path.replace(/\{args\.([A-Za-z0-9_]+)\}/g, "{$1}");
    const operation: Json = {
      operationId: tool.name,
      parameters: Object.keys(query ?? {}).map((name) => ({
        name,
        in: "query",
        schema: { type: "string" },
      })),
      ...(bodyMap
        ? {
            requestBody: {
              content: { "application/json": { schema: bodySchema(bodyMap) } },
            },
          }
        : {}),
      ...overrides(tool.name),
    };
    paths[specPath] = { ...paths[specPath], [method.toLowerCase()]: operation };
  }
  return { openapi: "3.1.0", paths, components: { schemas: {} } };
}

// DEV_NOTE: Answers SPEC_URL with spec (a function, so a test can change it between calls); undone by
// vi.restoreAllMocks. Any other URL goes to the fetch in place before.
export function serveSpec(spec: () => Json | null) {
  const current = globalThis.fetch;
  const previous = vi.isMockFunction(current) ? current.getMockImplementation() : current;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== SPEC_URL) return await (previous ?? current)(input, init);
    const body = spec();
    return body === null
      ? new Response("down", { status: 503 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
}
