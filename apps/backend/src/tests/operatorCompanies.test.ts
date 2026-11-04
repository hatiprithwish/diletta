import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { activityLog, admins, companies, companyConnections, eventOutbox } from "@/db/tables";
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

// DEV_NOTE: M7-8 operator company routes on the staging branch, through the whole worker (middleware → Repo as
// diletta_app). Company A has a staging connection and its own admin; B has none. Fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
let operatorAdminId = "";
const company = { a: "", aPublicId: "", b: "", bPublicId: "" };

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
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

async function statusAuditRows(companyId: string) {
  return await withOwnerDb(async (ownerDb) =>
    ownerDb
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        entityAction: activityLog.entityAction,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, Schemas.AuditEntityTypeEnum.Company),
        ),
      ),
  );
}

function setStatus(status: Schemas.CompanyStatusIntEnum, as = operator) {
  return call("PATCH", `/operator/companies/${company.aPublicId}/status`, {
    as,
    body: { company: { status } },
  });
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values(
        (["A", "B"] as const).map((name) => ({
          publicId: Utility.generatePublicId(),
          name: `Operator companies ${name} ${crypto.randomUUID()}`,
        })),
      )
      .returning({ id: companies.id, publicId: companies.publicId });
    company.a = created[0]!.id;
    company.aPublicId = created[0]!.publicId;
    company.b = created[1]!.id;
    company.bPublicId = created[1]!.publicId;
    await ownerDb.insert(companyConnections).values({
      publicId: Utility.generatePublicId(),
      companyId: company.a,
      environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
      baseUrl: "https://staging.operator-companies.example",
      authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      authConfig: {},
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      jwtIssuer: `https://issuer-${crypto.randomUUID()}.example`,
      allowedOrigins: [],
    });
    const inserted = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null },
        { clerkUserId: adminA, companyId: company.a },
      ])
      .returning({ id: admins.id, clerkUserId: admins.clerkUserId });
    operatorAdminId = inserted.find((row) => row.clerkUserId === operator)!.id;
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA]));
    const companyIds = [company.a, company.b].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

// DEV_NOTE: Every request authenticates, resolves the company and runs its own transactions on the staging branch
const ROUTE_FLOW_TIMEOUT_MS = 120_000;

describe("Operator company routes (M7-8)", { timeout: ROUTE_FLOW_TIMEOUT_MS }, () => {
  it("refuses a company admin every operator company route", async () => {
    expect((await call("GET", "/operator/companies", { as: adminA })).status).toBe(403);
    expect((await call("GET", "/operator/companies/status-counts", { as: adminA })).status).toBe(
      403,
    );
    expect(
      (await call("GET", `/operator/companies/${company.aPublicId}`, { as: adminA })).status,
    ).toBe(403);
    expect((await setStatus(Schemas.CompanyStatusIntEnum.Paused, adminA)).status).toBe(403);
    expect(await statusAuditRows(company.a)).toEqual([]);
  });

  it("lists companies by status with their active connections' environments", async () => {
    const listed = await call(
      "GET",
      `/operator/companies?status=${Schemas.CompanyStatusIntEnum.Active}&pageSize=${Schemas.MAX_PAGE_SIZE}`,
      { as: operator },
    );
    expect(listed.status).toBe(200);
    const rows = listed.body.companies as Schemas.OperatorCompanyListItem[];
    expect(rows.every((row) => row.companyStatus === Schemas.CompanyStatusIntEnum.Active)).toBe(
      true,
    );
    expect(rows.every((row) => !("id" in row))).toBe(true);
    const rowA = rows.find((row) => row.publicId === company.aPublicId);
    expect(rowA?.connectionEnvironments).toEqual([
      Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
    ]);
    expect(rowA?.connectionEnvironmentLabels).toEqual([
      Schemas.CompanyConnectionEnvironmentLabelEnum.Staging,
    ]);
    expect(rows.find((row) => row.publicId === company.bPublicId)?.connectionEnvironments).toEqual(
      [],
    );

    const counted = await call("GET", "/operator/companies/status-counts", { as: operator });
    expect(counted.status).toBe(200);
    const counts = counted.body.counts as Schemas.CompanyStatusCounts;
    expect(counts[Schemas.CompanyStatusIntEnum.Active]).toBeGreaterThanOrEqual(2);
    expect(counts[Schemas.CompanyStatusIntEnum.Churned]).toBeGreaterThanOrEqual(0);
  });

  it("reads one company, and answers 404 for an unknown one", async () => {
    const read = await call("GET", `/operator/companies/${company.aPublicId}`, { as: operator });
    expect(read.status).toBe(200);
    const found = read.body.company as Schemas.CompanyWithStatus;
    expect(found.publicId).toBe(company.aPublicId);
    expect(found).not.toHaveProperty("id");

    expect(
      (await call("GET", "/operator/companies/no_such_company", { as: operator })).status,
    ).toBe(404);
    expect((await setStatus(Schemas.CompanyStatusIntEnum.Paused)).status).toBe(200);
    expect(
      (
        await call("PATCH", "/operator/companies/no_such_company/status", {
          as: operator,
          body: { company: { status: Schemas.CompanyStatusIntEnum.Paused } },
        })
      ).status,
    ).toBe(404);
    expect((await setStatus(Schemas.CompanyStatusIntEnum.Active)).status).toBe(200);
  });

  it("pauses, churns and reactivates a company, each move audited as Operator once", async () => {
    await withOwnerDb((ownerDb) =>
      ownerDb.delete(activityLog).where(eq(activityLog.companyId, company.a)),
    );

    const paused = await setStatus(Schemas.CompanyStatusIntEnum.Paused);
    expect(paused.status).toBe(200);
    expect((paused.body.company as Schemas.CompanyWithStatus).companyStatusLabel).toBe(
      Schemas.CompanyStatusLabelEnum.Paused,
    );
    // The status already in force records nothing
    expect((await setStatus(Schemas.CompanyStatusIntEnum.Paused)).status).toBe(200);

    expect((await setStatus(Schemas.CompanyStatusIntEnum.Churned)).status).toBe(200);
    // A churned company's own admin loses the dashboard at once
    expect((await call("GET", "/dashboard/me", { as: adminA })).status).toBe(403);

    expect((await setStatus(Schemas.CompanyStatusIntEnum.Active)).status).toBe(200);
    expect((await call("GET", "/dashboard/me", { as: adminA })).status).toBe(200);

    const actions = (await statusAuditRows(company.a)).map((row) => {
      expect(row.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.Operator);
      expect(row.actorId).toBe(operatorAdminId);
      return row.entityAction;
    });
    expect(actions.sort()).toEqual(
      [
        Schemas.AuditEntityActionEnum.Paused,
        Schemas.AuditEntityActionEnum.Churned,
        Schemas.AuditEntityActionEnum.Resumed,
      ].sort(),
    );
  });

  it("refuses a status that doesn't exist", async () => {
    const refused = await call("PATCH", `/operator/companies/${company.aPublicId}/status`, {
      as: operator,
      body: { company: { status: 9 } },
    });
    expect(refused.status).toBe(400);
  });
});
