import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
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
  companyConnections,
  companyEncryptionKeys,
  conversations,
  eventOutbox,
  qualityIssues,
} from "@/db/tables";
import CompaniesRepo from "@/repositories/CompaniesRepo";
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

// DEV_NOTE: The Security page's API (M4-9) through the whole worker, as diletta_app: identity and origins, encryption
// keys, retention and prompt-injection events, each write with its audit row. The companies are made through
// CompaniesRepo (so each has its key v1); the other fixtures and cleanup run as the owner on the Neon staging branch.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const productionIssuer = `https://auth-${crypto.randomUUID()}.example.com`;
const stagingIssuer = `https://staging-${crypto.randomUUID()}.example.com`;
const JWKS_FETCHED_AT = Date.parse("2026-10-25T08:00:00Z");
let companyA = "";
let companyB = "";
let productionConnection = "";
let stagingConnection = "";
let connectionB = "";
let flaggedIssue = "";
let conversationPublicId = "";

type Body = Record<string, unknown> &
  Schemas.GetSecurityConnectionsApiResponse &
  Schemas.UpdateAllowedOriginsApiResponse &
  Schemas.RotateEncryptionKeyApiResponse &
  Schemas.GetContentRetentionApiResponse &
  Schemas.GetInjectionEventsApiResponse &
  Schemas.GetAuditLogApiResponse;

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
): Promise<{ status: number; body: Body }> {
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

async function createCompany(): Promise<string> {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Security ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const publicId = created.company.publicId;
  let companyId = "";
  await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, publicId));
    companyId = row?.id ?? "";
  });
  return companyId;
}

// DEV_NOTE: The company's audit rows (M4-9) of one entity type, oldest first, read as the owner
async function auditEvents(companyId: string, entityType: string) {
  let rows: { actorType: number; entityAction: string; detail: unknown }[] = [];
  await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, entityType),
    ];
    rows = await ownerDb
      .select({
        actorType: activityLog.actorType,
        entityAction: activityLog.entityAction,
        detail: activityLog.detail,
      })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  });
  return rows;
}

beforeAll(async () => {
  companyA = await createCompany();
  companyB = await createCompany();
  await withOwnerDb(async (ownerDb) => {
    const createdAdmins = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null },
        { clerkUserId: adminA, companyId: companyA, name: "Ana Ruiz" },
        { clerkUserId: adminB, companyId: companyB },
      ])
      .returning({ id: admins.id });
    const adminAId = createdAdmins[1]!.id;

    const connection = (
      companyId: string,
      environment: Schemas.CompanyConnectionEnvironmentIntEnum,
      jwtIssuer: string,
      allowedOrigins: string[],
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      environment,
      baseUrl: "https://api.example.com",
      authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      authConfig: {},
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      jwtIssuer,
      allowedOrigins,
    });
    const connections = await ownerDb
      .insert(companyConnections)
      .values([
        connection(companyA, Schemas.CompanyConnectionEnvironmentIntEnum.Staging, stagingIssuer, [
          "https://staging.example.com",
        ]),
        connection(
          companyA,
          Schemas.CompanyConnectionEnvironmentIntEnum.Production,
          productionIssuer,
          ["https://app.example.com", "https://help.example.com"],
        ),
        connection(
          companyB,
          Schemas.CompanyConnectionEnvironmentIntEnum.Production,
          `https://b-${crypto.randomUUID()}.example.com`,
          ["https://b.example.com"],
        ),
      ])
      .returning({ publicId: companyConnections.publicId });
    stagingConnection = connections[0]!.publicId;
    productionConnection = connections[1]!.publicId;
    connectionB = connections[2]!.publicId;

    const [bot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" })
      .returning({ id: chatbots.id });
    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    conversationPublicId = Utility.generatePublicId();
    const [conv] = await ownerDb
      .insert(conversations)
      .values({
        publicId: conversationPublicId,
        companyId: companyA,
        chatbotUserId: user!.id,
        chatbotId: bot!.id,
        title: "Bulk import help",
      })
      .returning({ id: conversations.id });

    // DEV_NOTE: Two issues typed Prompt injection (an admin's with a note an hour ago, an automatic one fixed now) and a
    // knowledge gap the events leave out
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    flaggedIssue = Utility.generatePublicId();
    await ownerDb.insert(qualityIssues).values([
      {
        publicId: flaggedIssue,
        companyId: companyA,
        conversationId: conv!.id,
        source: Schemas.QualityIssueSourceIntEnum.Admin,
        createdBy: adminAId,
        issueType: Schemas.QualityIssueTypeIntEnum.Injection,
        note: "Record note on EXT-T-901",
        createdAt: anHourAgo,
      },
      {
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        conversationId: conv!.id,
        source: Schemas.QualityIssueSourceIntEnum.System,
        status: Schemas.QualityIssueStatusIntEnum.Fixed,
        issueType: Schemas.QualityIssueTypeIntEnum.Injection,
      },
      {
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        conversationId: conv!.id,
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType: Schemas.QualityIssueTypeIntEnum.KnowledgeGap,
      },
    ]);
  });

  // DEV_NOTE: The production issuer's keys are in the cache; the staging one's never were
  const cached: Schemas.CachedJwks = { keys: [], fetchedAt: JWKS_FETCHED_AT };
  await env.JWKS_CACHE.put(`jwks:${productionIssuer}`, JSON.stringify(cached));
});

afterAll(async () => {
  await env.JWKS_CACHE.delete(`jwks:${productionIssuer}`);
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("Security page API (M4-9)", { timeout: 60_000 }, () => {
  it("lists the connections production first, with when their signing keys were fetched", async () => {
    const { status, body } = await call("GET", "/dashboard/security/connections", { as: adminA });
    expect(status).toBe(200);
    expect(body.connections).toEqual([
      {
        publicId: productionConnection,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Production,
        environmentLabel: Schemas.CompanyConnectionEnvironmentLabelEnum.Production,
        status: Schemas.CompanyConnectionStatusIntEnum.Active,
        statusLabel: Schemas.CompanyConnectionStatusLabelEnum.Active,
        jwtIssuer: productionIssuer,
        allowedOrigins: ["https://app.example.com", "https://help.example.com"],
        signingKeysFetchedAt: new Date(JWKS_FETCHED_AT).toISOString(),
      },
      expect.objectContaining({
        publicId: stagingConnection,
        jwtIssuer: stagingIssuer,
        signingKeysFetchedAt: null,
      }),
    ]);
    expect(body.connections?.[0]).not.toHaveProperty("authConfig");
    expect(body.connections?.[0]).not.toHaveProperty("baseUrl");

    const other = await call("GET", "/dashboard/security/connections", { as: adminB });
    expect(other.body.connections?.map((connection) => connection.publicId)).toEqual([connectionB]);
  });

  it("replaces a connection's allowed origins once, with its audit row", async () => {
    const path = `/dashboard/security/connections/${productionConnection}/origins`;
    const origins = ["https://app.example.com", "https://portal.example.com:8443"];

    const updated = await call("PUT", path, { as: adminA, body: { allowedOrigins: origins } });
    expect(updated.status).toBe(200);
    expect(updated.body.connection?.allowedOrigins).toEqual(origins);
    expect(updated.body).not.toHaveProperty("outboxIds");

    // DEV_NOTE: The same list again changes nothing and records nothing
    expect(
      (await call("PUT", path, { as: adminA, body: { allowedOrigins: origins } })).status,
    ).toBe(200);
    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.CompanyConnection)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.OriginsChanged,
        detail: { label: "Production" },
      },
    ]);
  });

  it("refuses an origin with a path, none, a repeat, another company's connection and an operator", async () => {
    const path = `/dashboard/security/connections/${productionConnection}/origins`;
    for (const allowedOrigins of [
      ["https://app.example.com/widget"],
      ["app.example.com"],
      [],
      ["https://app.example.com", "https://app.example.com"],
    ]) {
      expect((await call("PUT", path, { as: adminA, body: { allowedOrigins } })).status).toBe(400);
    }
    const body = { allowedOrigins: ["https://evil.example.com"] };
    expect(
      (
        await call("PUT", `/dashboard/security/connections/${connectionB}/origins`, {
          as: adminA,
          body,
        })
      ).status,
    ).toBe(404);
    expect((await call("PUT", path, { as: operator, body })).status).toBe(403);
    expect((await call("PUT", path, { body })).status).toBe(401);
  });

  it("rotates the company key once, refuses a second rotation while the first is in progress", async () => {
    const before = await call("GET", "/dashboard/security/encryption-keys", { as: adminA });
    expect(before.status).toBe(200);
    expect(before.body.isRotationInProgress).toBe(false);
    expect(
      before.body.encryptionKeys?.map(({ version, status, rotatedAt }) => ({
        version,
        status,
        rotatedAt,
      })),
    ).toEqual([
      { version: 1, status: Schemas.CompanyEncryptionKeyStatusIntEnum.Active, rotatedAt: null },
    ]);
    expect(before.body.encryptionKeys?.[0]).not.toHaveProperty("encryptedKey");
    expect(before.body.encryptionKeys?.[0]).not.toHaveProperty("masterKeyVersion");

    const rotated = await call("POST", "/dashboard/security/encryption-keys/rotate", {
      as: adminA,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.isRotationInProgress).toBe(true);
    expect(rotated.body.encryptionKeys?.map((key) => [key.version, key.statusLabel])).toEqual([
      [2, Schemas.CompanyEncryptionKeyStatusLabelEnum.Active],
      [1, Schemas.CompanyEncryptionKeyStatusLabelEnum.Retiring],
    ]);
    expect(rotated.body.encryptionKeys?.[1]?.rotatedAt).not.toBeNull();

    const again = await call("POST", "/dashboard/security/encryption-keys/rotate", { as: adminA });
    expect(again.status).toBe(409);
    expect(again.body.failure).toBe(Schemas.EncryptionKeyRotateFailureEnum.RotationInProgress);
    expect(again.body.encryptionKeys).toHaveLength(2);

    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.CompanyEncryptionKey)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Rotated,
        detail: { label: "v2" },
      },
    ]);
    // DEV_NOTE: Company B's key never moved
    const other = await call("GET", "/dashboard/security/encryption-keys", { as: adminB });
    expect(other.body.encryptionKeys?.map((key) => key.version)).toEqual([1]);
    expect(
      (await call("POST", "/dashboard/security/encryption-keys/rotate", { as: operator })).status,
    ).toBe(403);
  });

  it("keeps chat content for the default until the company chooses, and saves a choice once", async () => {
    const before = await call("GET", "/dashboard/security/retention", { as: adminA });
    expect(before.body.retention).toEqual({
      contentRetentionDays: Schemas.DEFAULT_CONTENT_RETENTION_DAYS,
      isDefault: true,
    });

    expect(
      (
        await call("PUT", "/dashboard/security/retention", {
          as: adminA,
          body: { contentRetentionDays: 45 },
        })
      ).status,
    ).toBe(400);
    const saved = await call("PUT", "/dashboard/security/retention", {
      as: adminA,
      body: { contentRetentionDays: 90 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.retention).toEqual({ contentRetentionDays: 90, isDefault: false });
    await call("PUT", "/dashboard/security/retention", {
      as: adminA,
      body: { contentRetentionDays: 90 },
    });

    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.Company)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.RetentionChanged,
        detail: { label: "90 days" },
      },
    ]);
    const other = await call("GET", "/dashboard/security/retention", { as: adminB });
    expect(other.body.retention?.isDefault).toBe(true);
  });

  it("lists the issues typed Prompt injection newest first, never another company's", async () => {
    const { status, body } = await call("GET", "/dashboard/security/injection-events", {
      as: adminA,
    });
    expect(status).toBe(200);
    expect(
      body.injectionEvents?.map(
        ({ createdAt: _createdAt, publicId: _publicId, ...event }) => event,
      ),
    ).toEqual([
      {
        conversationPublicId,
        conversationTitle: "Bulk import help",
        detectedIn: Schemas.QualityIssueSourceLabelEnum.System,
        status: Schemas.QualityIssueStatusIntEnum.Fixed,
        statusLabel: Schemas.QualityIssueStatusLabelEnum.Fixed,
        actionLabel: "Fixed",
      },
      {
        conversationPublicId,
        conversationTitle: "Bulk import help",
        detectedIn: "Record note on EXT-T-901",
        status: Schemas.QualityIssueStatusIntEnum.Open,
        statusLabel: Schemas.QualityIssueStatusLabelEnum.Open,
        actionLabel: "Waiting for review",
      },
    ]);
    expect(body.injectionEvents?.[1]?.publicId).toBe(flaggedIssue);
    const counted = await call("GET", "/dashboard/security/injection-events/count", { as: adminA });
    expect(counted.body.totalRecords).toBe(2);

    const other = await call("GET", "/dashboard/security/injection-events", { as: adminB });
    expect(other.body.injectionEvents).toEqual([]);
    expect(
      (await call("GET", "/dashboard/security/injection-events", { as: operator })).status,
    ).toBe(403);
  });

  it("shows this page's writes in the audit log, in words", async () => {
    const { body } = await call("GET", "/dashboard/audit-log", { as: adminA });
    expect(body.auditLog?.map((entry) => [entry.actorName, entry.action, entry.on])).toEqual([
      ["Ana Ruiz", "Changed chat retention", "90 days"],
      ["Ana Ruiz", "Rotated encryption key", "v2"],
      ["Ana Ruiz", "Changed allowed origins", "Production"],
    ]);
  });
});
