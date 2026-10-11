import { env } from "cloudflare:test";
import { vi } from "vitest";
import { RestAdapter } from "@app/adapter";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Test-only bindings (vitest.config.mts), never declared in wrangler.jsonc: the test host runs as an
// auxiliary worker behind the TEST_HOST service binding, with fresh secrets per run
const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

// DEV_NOTE: A missing binding fails loudly at import, never as an empty issuer or secret (relative URLs, 401s)
function readStringBinding(name: "TEST_HOST_ISSUER" | "TEST_HOST_ADMIN_SECRET"): string {
  const value: unknown = name in env ? Reflect.get(env, name) : undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} binding missing (apps/backend/vitest.config.mts)`);
  }
  return value;
}

if (!("TEST_HOST" in env) || !isFetcher(env.TEST_HOST)) {
  throw new Error("TEST_HOST binding missing (apps/backend/vitest.config.mts)");
}
const testHost: Fetcher = env.TEST_HOST;
export const testHostIssuer = readStringBinding("TEST_HOST_ISSUER");
const testHostAdminSecret = readStringBinding("TEST_HOST_ADMIN_SECRET");

// DEV_NOTE: The adapter's fetch for the test host: every URL under the issuer reaches the auxiliary worker in-process
export const testHostFetch: typeof fetch = (input, init) => testHost.fetch(input, init);

export const newTestHostWorkspace = () => `ws_${crypto.randomUUID().replace(/-/g, "")}`;

export const testHostConnection = (): Schemas.HostConnection => ({
  adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
  baseUrl: Schemas.getTestHostBaseUrl(testHostIssuer),
  authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
  authConfig: {},
  credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
});

async function adminCall(path: string, method: string, body: unknown): Promise<Response> {
  return testHostFetch(`${testHostIssuer}${path}`, {
    method,
    headers: {
      [Schemas.TEST_HOST_ADMIN_HEADER]: testHostAdminSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function mintTestHostTokens(
  workspace: string,
  overrides: Partial<Schemas.TestHostTokenRequest> = {},
): Promise<Schemas.TestHostTokenResponse> {
  const response = await adminCall("/auth/tokens", "POST", {
    workspace,
    sub: "test-host-user",
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`Test host token mint failed: ${response.status}`);
  return response.json<Schemas.TestHostTokenResponse>();
}

export async function setTestHostFaults(workspace: string, faults: Schemas.TestHostFault[]) {
  const response = await adminCall(`/control/workspaces/${workspace}/faults`, "PUT", { faults });
  if (response.status !== 200) throw new Error(`Test host faults failed: ${response.status}`);
}

export async function resetTestHost(hostToken: string) {
  const response = await testHostFetch(`${testHostIssuer}/v1/_reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  if (response.status !== 200) throw new Error(`Test host reset failed: ${response.status}`);
}

// DEV_NOTE: An adapter on the test host for one host token (null = none, TokenNeeded). Retry waits are skipped.
export function testHostAdapter(getHostToken: Schemas.HostTokenSource): Schemas.HostAdapter {
  const created = RestAdapter.create({
    connection: testHostConnection(),
    getHostToken,
    fetch: testHostFetch,
    wait: async () => {},
  });
  if (!created.adapter) throw new Error(created.message);
  return created.adapter;
}

// One of Schemas.TEST_HOST_TOOL_DEFINITIONS with its ops loaded, as the runtime will read it
export function testHostTool(name: string): Schemas.TestHostToolDefinition {
  const tool = Schemas.TEST_HOST_TOOL_DEFINITIONS.find((definition) => definition.name === name);
  if (!tool) throw new Error(`No test host tool ${name}`);
  const loaded = Schemas.loadToolOps({
    schemaVersion: Schemas.CURRENT_TOOL_OPS_SCHEMA_VERSION,
    ops: tool.ops,
  });
  if (!loaded.ops) throw new Error(loaded.message);
  return { ...tool, ops: loaded.ops };
}

export function render(
  op: Schemas.ToolCallOp | Schemas.ToolReadbackOp | Schemas.ToolInverseOp,
  context: Schemas.ToolOpContext,
): Schemas.RenderedToolRequest {
  const rendered = Schemas.renderToolOp(op, context);
  if (!rendered.request) throw new Error(rendered.message);
  return rendered.request;
}

// DEV_NOTE: The global fetch as the module loaded, before any spy: the fallback when a spy has no implementation of its
// own (calling the spy itself would loop forever)
const unmockedFetch: typeof fetch = globalThis.fetch;
const testHostOrigin = new URL(testHostIssuer).origin;

// DEV_NOTE: Code under test that calls the host with the global fetch (the Conversation DO's adapter, M3-4) reaches the
// test host through this: every URL on the issuer's origin goes to the auxiliary worker, anything else to the fetch in
// place before (its mock implementation, or the unmocked fetch). vi.spyOn reuses a spy already on fetch, so this
// layers over its implementation (call mockCloudflare first, then this). Undone by vi.restoreAllMocks.
export function routeTestHostFetch() {
  const current = globalThis.fetch;
  const previous = vi.isMockFunction(current) ? current.getMockImplementation() : current;
  const next: typeof fetch = previous ?? unmockedFetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return URL.canParse(url) && new URL(url).origin === testHostOrigin
      ? await testHostFetch(input, init)
      : await next(input, init);
  });
}

// DEV_NOTE: The test company's tool definition columns for one of Schemas.TEST_HOST_TOOL_DEFINITIONS, as the seed
// script stores them (ops normalised at the current schema version)
export function testHostToolColumns(name: string) {
  const tool = Schemas.TEST_HOST_TOOL_DEFINITIONS.find((definition) => definition.name === name);
  if (!tool) throw new Error(`No test host tool ${name}`);
  const normalized = Schemas.normalizeToolOps(tool.ops);
  if (!normalized.ops || normalized.schemaVersion === undefined)
    throw new Error(normalized.message);
  return {
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    idempotencyMode: tool.idempotencyMode,
    approval: tool.approval,
    source: tool.source,
    schemaVersion: normalized.schemaVersion,
    inputSchema: normalized.ops.inputSchema,
    callOp: normalized.ops.callOp,
    readbackOp: normalized.ops.readbackOp,
    inverseOp: normalized.ops.inverseOp,
  };
}
