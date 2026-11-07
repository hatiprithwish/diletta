import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  eventOutbox,
  qualityIssues,
} from "@/db/tables";
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

// DEV_NOTE: ADR 0006 on the staging branch, through the whole worker (middleware → Repo as diletta_app). Company A is
// the one the operator acts in, B is company admin B's own, C has churned. Fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
let operatorAdminId = "";
let conversationPublicId = "";
const company = { a: "", aPublicId: "", b: "", bPublicId: "", c: "", cPublicId: "" };

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
  options: { as?: string; acting?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  if (options.acting) headers[Schemas.ACTING_COMPANY_HEADER] = options.acting;
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

async function auditRows(companyId: string) {
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

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values(
        (["A", "B", "C"] as const).map((name) => ({
          publicId: Utility.generatePublicId(),
          name: `Operator acting ${name} ${crypto.randomUUID()}`,
          status:
            name === "C"
              ? Schemas.CompanyStatusIntEnum.Churned
              : Schemas.CompanyStatusIntEnum.Active,
        })),
      )
      .returning({ id: companies.id, publicId: companies.publicId });
    company.a = created[0]!.id;
    company.aPublicId = created[0]!.publicId;
    company.b = created[1]!.id;
    company.bPublicId = created[1]!.publicId;
    company.c = created[2]!.id;
    company.cPublicId = created[2]!.publicId;
    const inserted = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null },
        { clerkUserId: adminB, companyId: company.b },
      ])
      .returning({ id: admins.id, clerkUserId: admins.clerkUserId });
    operatorAdminId = inserted.find((row) => row.clerkUserId === operator)!.id;
    // A conversation in company A for the flag test
    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: company.a,
        name: "Bot",
        isDefault: true,
      })
      .returning({ id: chatbots.id });
    const [chatbotUser] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: company.a, hostUserId: `user-${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    const [conversation] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: company.a,
        chatbotUserId: chatbotUser!.id,
        chatbotId: chatbot!.id,
      })
      .returning({ publicId: conversations.publicId });
    conversationPublicId = conversation!.publicId;
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminB]));
    const companyIds = [company.a, company.b, company.c].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

// DEV_NOTE: Every request authenticates, resolves the company and runs its own transactions on the staging branch
const ROUTE_FLOW_TIMEOUT_MS = 120_000;

describe("Operators acting in a company (ADR 0006)", { timeout: ROUTE_FLOW_TIMEOUT_MS }, () => {
  it("lists the companies an operator may act in on /dashboard/me, churned ones left out", async () => {
    const me = await call("GET", "/dashboard/me", { as: operator });
    expect(me.status).toBe(200);
    const admin = me.body.admin as Schemas.AdminProfile;
    expect(admin.role).toBe(Schemas.AdminRoleEnum.Operator);
    const listed = (admin.actingCompanies ?? []).map((row) => row.publicId);
    expect(listed).toEqual(expect.arrayContaining([company.aPublicId, company.bPublicId]));
    expect(listed).not.toContain(company.cPublicId);

    const own = await call("GET", "/dashboard/me", { as: adminB });
    expect((own.body.admin as Schemas.AdminProfile).actingCompanies).toBeNull();
  });

  it("answers an operator 403 with no company, 404 for an unknown one and 403 for a churned one", async () => {
    const path = "/dashboard/security/retention";
    expect((await call("GET", path, { as: operator })).status).toBe(403);
    expect((await call("GET", path, { as: operator, acting: "no_such_company" })).status).toBe(404);
    expect((await call("GET", path, { as: operator, acting: company.cPublicId })).status).toBe(403);
  });

  it("lets an operator read and change the company they act in, audited as Operator", async () => {
    const read = await call("GET", "/dashboard/security/retention", {
      as: operator,
      acting: company.aPublicId,
    });
    expect(read.status).toBe(200);

    const changed = await call("PUT", "/dashboard/security/retention", {
      as: operator,
      acting: company.aPublicId,
      body: { contentRetentionDays: 90 },
    });
    expect(changed.status).toBe(200);

    const rows = await auditRows(company.a);
    expect(rows).toContainEqual({
      actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
      actorId: operatorAdminId,
      entityAction: Schemas.AuditEntityActionEnum.RetentionChanged,
    });
    // Company B is untouched
    expect(await auditRows(company.b)).toEqual([]);
  });

  it("records an operator's entry once per pick, and refuses it to a company admin", async () => {
    const entered = await call("POST", "/dashboard/acting", {
      as: operator,
      acting: company.aPublicId,
    });
    expect(entered.status).toBe(200);
    const rows = (await auditRows(company.a)).filter(
      (row) => row.entityAction === Schemas.AuditEntityActionEnum.OperatorActed,
    );
    expect(rows).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
        actorId: operatorAdminId,
        entityAction: Schemas.AuditEntityActionEnum.OperatorActed,
      },
    ]);

    expect((await call("POST", "/dashboard/acting", { as: adminB })).status).toBe(403);
  });

  it("lets an operator flag a conversation in the company they act in, as the Operator", async () => {
    const flagged = await call("POST", `/dashboard/conversations/${conversationPublicId}/flag`, {
      as: operator,
      acting: company.aPublicId,
    });
    expect([200, 201]).toContain(flagged.status);

    const [issues, events] = await withOwnerDb(async (ownerDb) => {
      const issueRows = await ownerDb
        .select({ createdBy: qualityIssues.createdBy, source: qualityIssues.source })
        .from(qualityIssues)
        .where(eq(qualityIssues.companyId, company.a));
      const eventRows = await ownerDb
        .select({ actorType: activityLog.actorType, actorId: activityLog.actorId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, company.a),
            eq(activityLog.entityType, Schemas.QUALITY_ISSUE_ENTITY_TYPE),
          ),
        );
      return [issueRows, eventRows] as const;
    });
    expect(issues).toEqual([
      { createdBy: operatorAdminId, source: Schemas.QualityIssueSourceIntEnum.Admin },
    ]);
    expect(events).toEqual([
      { actorType: Schemas.ActivityLogActorTypeIntEnum.Operator, actorId: operatorAdminId },
    ]);
  });

  it("ignores a company admin's acting header: they only ever reach their own company", async () => {
    const changed = await call("PUT", "/dashboard/security/retention", {
      as: adminB,
      acting: company.aPublicId,
      body: { contentRetentionDays: 180 },
    });
    expect(changed.status).toBe(200);

    const aRows = await auditRows(company.a);
    expect(aRows.some((row) => row.actorId !== operatorAdminId)).toBe(false);
    const bRows = await auditRows(company.b);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
      entityAction: Schemas.AuditEntityActionEnum.RetentionChanged,
    });
  });
});
