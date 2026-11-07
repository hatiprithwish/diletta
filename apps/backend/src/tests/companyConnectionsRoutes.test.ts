import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { activityLog, admins, companies, companyConnections, eventOutbox } from "@/db/tables";
import worker from "@/index";
import Utility from "@/utils/Utility";
import { SPEC_URL, serveSpec, specFor } from "@/tests/helpers/toolSpec";
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
// Fixtures and cleanup run as the owner. Two companies: A is the one the routes name, B owns a connection A must
// never reach.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
let companyA = "";
let companyAPublicId = "";
let companyB = "";
let connectionB = "";

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

const base = () => `/operator/companies/${companyAPublicId}/connections`;

// DEV_NOTE: jwt_issuer is unique across every company on the branch, so each connection gets a fresh one
const stagingConnection = (jwtIssuer = `https://${crypto.randomUUID()}.example.com`) => ({
  companyConnection: {
    environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
    baseUrl: `${jwtIssuer}/api/p/`,
    authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
    authConfig: {},
    credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
    jwtIssuer,
    allowedOrigins: ["https://app.example.com"],
  },
});

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        {
          publicId: Utility.generatePublicId(),
          name: `Connection routes A ${crypto.randomUUID()}`,
        },
        {
          publicId: Utility.generatePublicId(),
          name: `Connection routes B ${crypto.randomUUID()}`,
        },
      ])
      .returning({ id: companies.id, publicId: companies.publicId });
    companyA = created[0]!.id;
    companyAPublicId = created[0]!.publicId;
    companyB = created[1]!.id;
    const [connection] = await ownerDb
      .insert(companyConnections)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyB,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: "https://host-b.example.com",
        authType: "jwt_forward",
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
        allowedOrigins: ["https://host-b.example.com"],
      })
      .returning({ publicId: companyConnections.publicId });
    connectionB = connection!.publicId;
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
    ]);
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA]));
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// DEV_NOTE: Every request authenticates, resolves the company and runs its own transactions on the staging branch, so a
// multi-step flow outlasts the default per-test timeout
const ROUTE_FLOW_TIMEOUT_MS = 120_000;

describe(
  "/operator/companies/:companyPublicId/connections",
  { timeout: ROUTE_FLOW_TIMEOUT_MS },
  () => {
    it("answers 401 signed out and 403 to a company admin, even on their own company and with a bad body", async () => {
      expect((await call("GET", base())).status).toBe(401);
      expect((await call("GET", base(), { as: adminA })).status).toBe(403);
      expect((await call("POST", base(), { as: adminA, body: stagingConnection() })).status).toBe(
        403,
      );
      expect((await call("POST", base(), { as: adminA, body: {} })).status).toBe(403);
      expect(
        (await call("PATCH", `${base()}/${connectionB}`, { as: adminA, body: {} })).status,
      ).toBe(403);
    });

    it("answers 404 for an unknown company", async () => {
      const response = await call("GET", "/operator/companies/cmp_missing/connections", {
        as: operator,
      });
      expect(response.status).toBe(404);
    });

    it("creates, reads, lists and updates a connection, with its audit rows", async () => {
      const created = await call("POST", base(), { as: operator, body: stagingConnection() });
      expect(created.status).toBe(201);
      const connection = created.body.companyConnection as Schemas.CompanyConnectionWithStatus;
      expect(connection.companyConnectionEnvironmentLabel).toBe(
        Schemas.CompanyConnectionEnvironmentLabelEnum.Staging,
      );
      expect(connection).not.toHaveProperty("id");
      expect(connection).not.toHaveProperty("companyId");
      expect(connection).not.toHaveProperty("createdBy");
      expect(created.body).not.toHaveProperty("outboxIds");

      const fetched = await call("GET", `${base()}/${connection.publicId}`, { as: operator });
      expect(fetched.status).toBe(200);
      const listed = await call("GET", base(), { as: operator });
      expect(listed.status).toBe(200);
      expect(
        (listed.body.companyConnections as Schemas.CompanyConnectionWithStatus[]).map(
          (row) => row.publicId,
        ),
      ).toEqual([connection.publicId]);

      const updated = await call("PATCH", `${base()}/${connection.publicId}`, {
        as: operator,
        body: { companyConnection: { allowedOrigins: ["https://pilot.example.com"] } },
      });
      expect(updated.status).toBe(200);
      expect(
        (updated.body.companyConnection as Schemas.CompanyConnectionWithStatus).allowedOrigins,
      ).toEqual(["https://pilot.example.com"]);

      let actions: string[] = [];
      await withOwnerDb(async (ownerDb) => {
        const rows = await ownerDb
          .select({ entityAction: activityLog.entityAction })
          .from(activityLog)
          .where(inArray(activityLog.companyId, [companyA]));
        actions = rows.map((row) => row.entityAction).sort();
      });
      expect(actions).toEqual(
        [
          Schemas.AuditEntityActionEnum.Created,
          Schemas.AuditEntityActionEnum.OriginsChanged,
        ].sort(),
      );
    });

    it("answers 409 for a taken issuer, 400 for a reset op on production, and 400 for a bad body", async () => {
      const first = await call("POST", base(), { as: operator, body: stagingConnection() });
      expect(first.status).toBe(201);
      const issuer = (first.body.companyConnection as Schemas.CompanyConnectionWithStatus)
        .jwtIssuer;

      const taken = await call("POST", base(), { as: operator, body: stagingConnection(issuer) });
      expect(taken.status).toBe(409);
      expect(taken.body.failure).toBe(Schemas.CompanyConnectionFailureEnum.IssuerTaken);

      const production = stagingConnection();
      const createdProduction = await call("POST", base(), {
        as: operator,
        body: {
          companyConnection: {
            ...production.companyConnection,
            environment: Schemas.CompanyConnectionEnvironmentIntEnum.Production,
          },
        },
      });
      expect(createdProduction.status).toBe(201);
      const productionId = (
        createdProduction.body.companyConnection as Schemas.CompanyConnectionWithStatus
      ).publicId;
      const resetOnProduction = await call("PATCH", `${base()}/${productionId}`, {
        as: operator,
        body: { companyConnection: { resetOp: Schemas.TEST_HOST_RESET_OP } },
      });
      expect(resetOnProduction.status).toBe(400);
      expect(resetOnProduction.body.failure).toBe(Schemas.CompanyConnectionFailureEnum.Invalid);

      const badBody = await call("POST", base(), {
        as: operator,
        body: {
          companyConnection: { ...stagingConnection().companyConnection, baseUrl: "http://x" },
        },
      });
      expect(badBody.status).toBe(400);
    });

    it("sets a spec URL and shaping, then checks and syncs the tool schemas: 403 / 404 / 400 / 502 / 200 (ADR 0009)", async () => {
      const created = await call("POST", base(), { as: operator, body: stagingConnection() });
      const publicId = (created.body.companyConnection as Schemas.CompanyConnectionWithStatus)
        .publicId;
      const path = `${base()}/${publicId}/contract-sync`;
      const body = { isDryRun: true };

      expect((await call("POST", path, { as: adminA, body })).status).toBe(403);
      expect((await call("POST", path, { as: operator, body: {} })).status).toBe(400);
      expect(
        (await call("POST", `${base()}/${connectionB}/contract-sync`, { as: operator, body }))
          .status,
      ).toBe(404);
      // No spec URL yet
      expect((await call("POST", path, { as: operator, body })).status).toBe(400);

      const refusedUrl = await call("PATCH", `${base()}/${publicId}`, {
        as: operator,
        body: { companyConnection: { openapiUrl: "http://host.example.com/openapi.json" } },
      });
      expect(refusedUrl.status).toBe(400);

      const set = await call("PATCH", `${base()}/${publicId}`, {
        as: operator,
        body: {
          companyConnection: {
            openapiUrl: SPEC_URL,
            openapiShaping: { isDefaultRequired: true, replaceComponents: {} },
          },
        },
      });
      expect(set.status).toBe(200);
      expect((set.body.companyConnection as Schemas.CompanyConnectionWithStatus).openapiUrl).toBe(
        SPEC_URL,
      );

      serveSpec(() => null);
      expect((await call("POST", path, { as: operator, body })).status).toBe(502);
      serveSpec(() => specFor([]));
      const checked = await call("POST", path, { as: operator, body });
      expect(checked.status).toBe(200);
      expect(checked.body).toMatchObject({ isSuccess: true, isDryRun: true, changes: [] });
    });

    it("never reads or changes another company's connection", async () => {
      const fetched = await call("GET", `${base()}/${connectionB}`, { as: operator });
      expect(fetched.status).toBe(404);
      const updated = await call("PATCH", `${base()}/${connectionB}`, {
        as: operator,
        body: { companyConnection: { baseUrl: "https://attacker.example.com" } },
      });
      expect(updated.status).toBe(404);
    });
  },
);
