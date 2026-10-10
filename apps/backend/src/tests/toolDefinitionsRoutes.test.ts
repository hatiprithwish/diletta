import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { admins, companies, companyConnections, toolDefinitions } from "@/db/tables";
import worker from "@/index";
import Utility from "@/utils/Utility";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Clerk stand-in. "Authorization: Bearer <clerkUserId>" signs in as that Clerk user; no header is
// signed out. Nobody here has invite metadata, so /dashboard/me never provisions.
vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: async (request: Request) => {
        const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!userId) {
          return { isSignedIn: false, reason: "session-token-missing" };
        }
        return {
          isSignedIn: true,
          toAuth: () => ({ userId, sessionId: `sess_${userId}`, sessionClaims: {} }),
        };
      },
    }),
    getAdminProfile: async () => ({
      isSuccess: true,
      profile: { email: null, name: null, companyPublicId: null },
    }),
    consumeInvite: async () => ({ isSuccess: true }),
  },
}));

// DEV_NOTE: Tests hit the Neon staging branch through the whole worker (middleware → Repo as diletta_app).
// Fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
let companyA = "";
let companyAPublicId = "";
let connectionA = "";

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.json() };
}

const base = () => `/operator/companies/${companyAPublicId}/tool-definitions`;

function readTool(name: string) {
  return {
    toolDefinition: {
      connectionPublicId: connectionA,
      name,
      description: "List records",
      risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.None,
      approval: Schemas.ToolDefinitionApprovalIntEnum.Never,
      source: Schemas.ToolDefinitionSourceIntEnum.Manual,
      ops: {
        inputSchema: { type: "object", properties: { status: { type: "string" } } },
        callOp: {
          method: Schemas.ToolOpMethodEnum.Get,
          path: "/records",
          query: { status: "{args.status}" },
        },
        readbackOp: null,
        inverseOp: null,
      },
    },
  };
}

const uniqueName = () => `list_records_${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .insert(companies)
      .values({ publicId: Utility.generatePublicId(), name: `Tool routes ${crypto.randomUUID()}` })
      .returning({ id: companies.id, publicId: companies.publicId });
    companyA = company!.id;
    companyAPublicId = company!.publicId;
    const [connection] = await ownerDb
      .insert(companyConnections)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: "https://host.example.com",
        authType: "jwt_forward",
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
        allowedOrigins: ["https://host.example.com"],
      })
      .returning({ publicId: companyConnections.publicId });
    connectionA = connection!.publicId;
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
    ]);
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA]));
    if (!companyA) return;
    await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, [companyA]));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, [companyA]));
    await ownerDb.delete(companies).where(inArray(companies.id, [companyA]));
  });
});

// DEV_NOTE: Every request authenticates, resolves the company and runs its own transactions on the staging branch, so a
// multi-step flow outlasts the default per-test timeout
const ROUTE_FLOW_TIMEOUT_MS = 120_000;

describe(
  "/operator/companies/:companyPublicId/tool-definitions",
  { timeout: ROUTE_FLOW_TIMEOUT_MS },
  () => {
    it("answers 401 signed out and 403 to a company admin, even on their own company and with a bad body", async () => {
      expect((await call("GET", base())).status).toBe(401);
      expect((await call("GET", base(), { as: adminA })).status).toBe(403);
      expect(
        (await call("POST", base(), { as: adminA, body: readTool(uniqueName()) })).status,
      ).toBe(403);
      expect((await call("POST", base(), { as: adminA, body: {} })).status).toBe(403);
    });

    it("answers 404 for an unknown company", async () => {
      const response = await call("GET", "/operator/companies/cmp_missing/tool-definitions", {
        as: operator,
      });
      expect(response.status).toBe(404);
    });

    it("creates, reads, lists, counts, activates and versions a tool", async () => {
      const name = uniqueName();
      const created = await call("POST", base(), { as: operator, body: readTool(name) });
      expect(created.status).toBe(201);
      const tool = created.body.toolDefinition as Schemas.ToolDefinitionWithStatus;
      expect(tool.version).toBe(1);
      expect(tool.connectionPublicId).toBe(connectionA);
      expect(tool).not.toHaveProperty("companyId");

      const fetched = await call("GET", `${base()}/${tool.publicId}`, { as: operator });
      expect(fetched.status).toBe(200);

      const listed = await call("GET", `${base()}?name=${name}&status=1`, { as: operator });
      expect(listed.status).toBe(200);
      expect((listed.body.toolDefinitions as unknown[]).length).toBe(1);
      const counted = await call("GET", `${base()}/count?name=${name}`, { as: operator });
      expect(counted.body.totalRecords).toBe(1);

      const activated = await call("PUT", `${base()}/${tool.publicId}/status`, {
        as: operator,
        body: { status: Schemas.ToolDefinitionStatusIntEnum.Active },
      });
      expect(activated.status).toBe(200);

      const edit = await call("PATCH", `${base()}/${tool.publicId}`, {
        as: operator,
        body: { toolDefinition: { description: "Changed" } },
      });
      expect(edit.status).toBe(409);
      expect(edit.body.failure).toBe(Schemas.ToolDefinitionFailureEnum.NotDraft);

      const v2 = await call("POST", `${base()}/${tool.publicId}/versions`, { as: operator });
      expect(v2.status).toBe(201);
      const v2Tool = v2.body.toolDefinition as Schemas.ToolDefinitionWithStatus;
      expect(v2Tool.version).toBe(2);

      const again = await call("POST", `${base()}/${tool.publicId}/versions`, { as: operator });
      expect(again.status).toBe(409);
      expect(again.body.failure).toBe(Schemas.ToolDefinitionFailureEnum.DraftExists);

      const deleted = await call("DELETE", `${base()}/${v2Tool.publicId}`, { as: operator });
      expect(deleted.status).toBe(200);
      const missing = await call("GET", `${base()}/${v2Tool.publicId}`, { as: operator });
      expect(missing.status).toBe(404);
    });

    it("answers 400 for invalid ops, a reserved name or an unknown connection, 409 for a taken name", async () => {
      const badRef = readTool(uniqueName());
      badRef.toolDefinition.ops.callOp.path = "/records/{args.recordId}";
      expect((await call("POST", base(), { as: operator, body: badRef })).status).toBe(400);

      const reserved = readTool(Schemas.SEARCH_HELP_DOCS_TOOL_NAME);
      expect((await call("POST", base(), { as: operator, body: reserved })).status).toBe(400);

      const unknownConnection = readTool(uniqueName());
      unknownConnection.toolDefinition.connectionPublicId = "con_missing";
      const refused = await call("POST", base(), { as: operator, body: unknownConnection });
      expect(refused.status).toBe(400);
      expect(refused.body.failure).toBe(Schemas.ToolDefinitionFailureEnum.ConnectionNotFound);

      const name = uniqueName();
      expect((await call("POST", base(), { as: operator, body: readTool(name) })).status).toBe(201);
      const taken = await call("POST", base(), { as: operator, body: readTool(name) });
      expect(taken.status).toBe(409);
      expect(taken.body.failure).toBe(Schemas.ToolDefinitionFailureEnum.NameTaken);
    });
  },
);
