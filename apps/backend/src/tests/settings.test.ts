import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  adminInvites,
  admins,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  eventOutbox,
  modelCalls,
} from "@/db/tables";
import AiGatewayProvider from "@/providers/aiGateway";
import ClerkProvider from "@/providers/clerk";
import AppLogger from "@/providers/logger";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
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
// signed out. Nobody here has invite metadata, so /dashboard/me never provisions. The Team methods (M4-10) answer as
// for a new email with nobody active; a test spies on one to change its answer.
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
    findUserByEmail: async () => ({ isSuccess: true, clerkUserId: null }),
    createInvitation: async () => ({ isSuccess: true, invitationId: `inv_${crypto.randomUUID()}` }),
    grantInvite: async () => ({ isSuccess: true }),
    revokeInvite: async () => ({ isSuccess: true }),
    getLastActive: async () => ({ isSuccess: true, lastActiveAt: {} }),
  },
}));

// DEV_NOTE: Settings › Model keys and Budget (M4-10) through the whole worker, as diletta_app, each write with its
// audit row. The provider's key check (AiGatewayProvider.checkModelKey) is mocked per test: no test reaches a provider.
// The companies are made through CompaniesRepo (so each has its key v1); the other fixtures and cleanup run as the owner
// on the Neon staging branch.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const adminA2 = `user_a2_${crypto.randomUUID()}`;
const existingClerkUser = `user_existing_${crypto.randomUUID()}`;
const ANTHROPIC_KEY = `sk-ant-${crypto.randomUUID()}`;
const ROTATED_KEY = `sk-ant-${crypto.randomUUID()}`;
let companyA = "";
let companyB = "";

type Body = Record<string, unknown> &
  Schemas.GetSettingsConnectionsApiResponse &
  Schemas.GetTeamApiResponse &
  Schemas.TeamWriteApiResponse &
  Schemas.GetModelKeysApiResponse &
  Schemas.ModelKeyWriteApiResponse &
  Schemas.GetSpendingBudgetApiResponse;

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
): Promise<{ status: number; body: Body; text: string }> {
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
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

async function createCompany(): Promise<string> {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Settings ${crypto.randomUUID()}` },
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

async function modelKeyRows(companyId: string) {
  let rows: (typeof companySecrets.$inferSelect)[] = [];
  await withOwnerDb(async (ownerDb) => {
    rows = await ownerDb
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId))
      .orderBy(asc(companySecrets.id));
  });
  return rows;
}

function mockKeyCheck(outcome: Schemas.ModelKeyCheckOutcomeEnum) {
  return vi.spyOn(AiGatewayProvider, "checkModelKey").mockResolvedValue(outcome);
}

beforeAll(async () => {
  companyA = await createCompany();
  companyB = await createCompany();
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA, name: "Ana Ruiz" },
      { clerkUserId: adminB, companyId: companyB },
      {
        clerkUserId: adminA2,
        companyId: companyA,
        name: "Marcus Lee",
        email: "Marcus@Example.com",
      },
    ]);
    const connection = (
      environment: Schemas.CompanyConnectionEnvironmentIntEnum,
      baseUrl: string,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      environment,
      baseUrl,
      authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      authConfig: {},
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      jwtIssuer: `https://issuer-${crypto.randomUUID()}.example.com`,
      allowedOrigins: ["https://app.example.com"],
    });
    await ownerDb
      .insert(companyConnections)
      .values([
        connection(
          Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
          "https://staging-api.example.com/v1",
        ),
        connection(
          Schemas.CompanyConnectionEnvironmentIntEnum.Production,
          "https://api.example.com/v1",
        ),
      ]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb
      .delete(admins)
      .where(inArray(admins.clerkUserId, [operator, adminA, adminB, adminA2]));
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
    await ownerDb.delete(adminInvites).where(inArray(adminInvites.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("Settings › Model keys API (M4-10)", { timeout: 60_000 }, () => {
  it("saves nothing for a key the provider refuses or that can't be checked", async () => {
    const check = mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Rejected);
    const rejected = await call("POST", "/dashboard/settings/model-keys", {
      as: adminA,
      body: { provider: Schemas.ModelProviderEnum.Anthropic, secret: ANTHROPIC_KEY },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.failure).toBe(Schemas.ModelKeyFailureEnum.KeyRejected);
    expect(check).toHaveBeenCalledWith(expect.anything(), {
      provider: Schemas.ModelProviderEnum.Anthropic,
      apiKey: ANTHROPIC_KEY,
    });

    mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Unreachable);
    const unchecked = await call("POST", "/dashboard/settings/model-keys", {
      as: adminA,
      body: { provider: Schemas.ModelProviderEnum.Anthropic, secret: ANTHROPIC_KEY },
    });
    expect(unchecked.status).toBe(502);
    expect(unchecked.body.failure).toBe(Schemas.ModelKeyFailureEnum.CheckUnavailable);

    expect(await modelKeyRows(companyA)).toEqual([]);
    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.ModelKey)).toEqual([]);
  });

  it("adds a checked key once per provider, never echoing or logging its value", async () => {
    mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Valid);
    const added = await call("POST", "/dashboard/settings/model-keys", {
      as: adminA,
      body: { provider: Schemas.ModelProviderEnum.Anthropic, secret: ANTHROPIC_KEY },
    });
    expect(added.status).toBe(201);
    expect(added.text).not.toContain(ANTHROPIC_KEY);
    expect(added.body.modelKey).toMatchObject({
      provider: Schemas.ModelProviderEnum.Anthropic,
      providerLabel: "Anthropic",
      lastFourChars: ANTHROPIC_KEY.slice(-4),
      status: Schemas.CompanySecretStatusIntEnum.Active,
      statusLabel: Schemas.CompanySecretStatusLabelEnum.Active,
      rotatedAt: null,
    });
    expect(added.body.modelKey?.lastValidatedAt).not.toBeNull();

    const [row] = await modelKeyRows(companyA);
    expect(row?.type).toBe(Schemas.CompanySecretTypeIntEnum.ModelKey);
    expect(Buffer.from(row!.encryptedSecret).toString("utf8")).not.toContain(ANTHROPIC_KEY);

    const check = vi.mocked(AiGatewayProvider.checkModelKey);
    check.mockClear();
    const again = await call("POST", "/dashboard/settings/model-keys", {
      as: adminA,
      body: { provider: Schemas.ModelProviderEnum.Anthropic, secret: ROTATED_KEY },
    });
    expect(again.status).toBe(409);
    // DEV_NOTE: Refused before anything is sent to the provider
    expect(check).not.toHaveBeenCalled();
    expect(again.body.failure).toBe(Schemas.ModelKeyFailureEnum.ProviderHasActiveKey);
    expect(await modelKeyRows(companyA)).toHaveLength(1);

    const listed = await call("GET", "/dashboard/settings/model-keys", { as: adminA });
    expect(listed.status).toBe(200);
    expect(listed.body.modelKeys?.map((key) => key.publicId)).toEqual([
      added.body.modelKey?.publicId,
    ]);
    expect(listed.text).not.toContain(ANTHROPIC_KEY);

    const logged = JSON.stringify(vi.mocked(AppLogger.error).mock.calls);
    expect(logged).not.toContain(ANTHROPIC_KEY);
    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.ModelKey)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Created,
        detail: { label: "Anthropic" },
      },
    ]);
  });

  it("rotates an invalid key back to Active once the provider accepts the new value", async () => {
    const [row] = await modelKeyRows(companyA);
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(companySecrets)
        .set({ status: Schemas.CompanySecretStatusIntEnum.Invalid })
        .where(eq(companySecrets.id, row!.id));
    });

    mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Rejected);
    const refused = await call("POST", `/dashboard/settings/model-keys/${row!.publicId}/rotate`, {
      as: adminA,
      body: { secret: ROTATED_KEY },
    });
    expect(refused.status).toBe(400);
    expect((await modelKeyRows(companyA))[0]?.status).toBe(
      Schemas.CompanySecretStatusIntEnum.Invalid,
    );

    const check = mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Valid);
    const rotated = await call("POST", `/dashboard/settings/model-keys/${row!.publicId}/rotate`, {
      as: adminA,
      body: { secret: ROTATED_KEY },
    });
    expect(rotated.status).toBe(200);
    expect(check).toHaveBeenCalledWith(expect.anything(), {
      provider: Schemas.ModelProviderEnum.Anthropic,
      apiKey: ROTATED_KEY,
    });
    expect(rotated.text).not.toContain(ROTATED_KEY);
    expect(rotated.body.modelKey).toMatchObject({
      publicId: row!.publicId,
      lastFourChars: ROTATED_KEY.slice(-4),
      status: Schemas.CompanySecretStatusIntEnum.Active,
    });
    expect(rotated.body.modelKey?.rotatedAt).not.toBeNull();

    // DEV_NOTE: The router reads the new value
    const decrypted = await new CompanySecretsRepo(env).getDecryptedCompanySecret({
      companyId: companyA,
      publicId: row!.publicId,
    });
    expect(decrypted.secret).toBe(ROTATED_KEY);
    expect(
      (await auditEvents(companyA, Schemas.AuditEntityTypeEnum.ModelKey)).map(
        (event) => event.entityAction,
      ),
    ).toEqual([Schemas.AuditEntityActionEnum.Created, Schemas.AuditEntityActionEnum.Rotated]);
  });

  it("refuses to rotate an invalid key back to Active while the provider has another Active key", async () => {
    const [row] = await modelKeyRows(companyA);
    const otherPublicId = Utility.generatePublicId();
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(companySecrets)
        .set({ status: Schemas.CompanySecretStatusIntEnum.Invalid })
        .where(eq(companySecrets.id, row!.id));
      await ownerDb.insert(companySecrets).values({
        publicId: otherPublicId,
        companyId: companyA,
        type: Schemas.CompanySecretTypeIntEnum.ModelKey,
        provider: Schemas.ModelProviderEnum.Anthropic,
        encryptedSecret: Buffer.from([1, 2, 3]),
        iv: Buffer.from([4, 5, 6]),
        encryptionKeyVersion: 1,
        lastFourChars: "",
      });
    });
    try {
      mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Valid);
      const refused = await call("POST", `/dashboard/settings/model-keys/${row!.publicId}/rotate`, {
        as: adminA,
        body: { secret: ROTATED_KEY },
      });
      expect(refused.status).toBe(409);
      expect(refused.body.failure).toBe(Schemas.ModelKeyFailureEnum.ProviderHasActiveKey);
      const after = await modelKeyRows(companyA);
      expect(after.find((key) => key.id === row!.id)?.status).toBe(
        Schemas.CompanySecretStatusIntEnum.Invalid,
      );
    } finally {
      await withOwnerDb(async (ownerDb) => {
        await ownerDb.delete(companySecrets).where(eq(companySecrets.publicId, otherPublicId));
        await ownerDb
          .update(companySecrets)
          .set({ status: Schemas.CompanySecretStatusIntEnum.Active })
          .where(eq(companySecrets.id, row!.id));
      });
    }
  });

  it("never shows or rotates another company's key, and refuses an operator", async () => {
    const [row] = await modelKeyRows(companyA);
    const check = mockKeyCheck(Schemas.ModelKeyCheckOutcomeEnum.Valid);

    const listed = await call("GET", "/dashboard/settings/model-keys", { as: adminB });
    expect(listed.body.modelKeys).toEqual([]);
    const rotated = await call("POST", `/dashboard/settings/model-keys/${row!.publicId}/rotate`, {
      as: adminB,
      body: { secret: ROTATED_KEY },
    });
    expect(rotated.status).toBe(404);
    // DEV_NOTE: An unknown key is refused before anything is sent to a provider
    expect(check).not.toHaveBeenCalled();

    expect((await call("GET", "/dashboard/settings/model-keys", { as: operator })).status).toBe(
      403,
    );
    expect(
      (
        await call("POST", "/dashboard/settings/model-keys", {
          as: operator,
          body: { provider: Schemas.ModelProviderEnum.OpenAI, secret: ROTATED_KEY },
        })
      ).status,
    ).toBe(403);
  });
});

describe("Settings › Budget API (M4-10)", { timeout: 60_000 }, () => {
  it("shows the default budget and this period's spend, without embeddings or last period", async () => {
    const now = Date.now();
    const periodStart = Schemas.budgetPeriodStart(Schemas.budgetPeriodKey(now));
    const spend = (
      costUsd: string,
      createdAt: Date,
      tier: Schemas.ModelCallTierIntEnum,
    ): typeof modelCalls.$inferInsert => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
      tier,
      provider: Schemas.ModelProviderEnum.Anthropic,
      model: "claude-sonnet-5-5",
      costUsd,
      createdAt,
      updatedAt: createdAt,
    });
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .insert(modelCalls)
        .values([
          spend("1.250000", new Date(now), Schemas.ModelCallTierIntEnum.Mid),
          spend("0.500000", new Date(now), Schemas.ModelCallTierIntEnum.Embed),
          spend("4.000000", new Date(periodStart.getTime() - 1), Schemas.ModelCallTierIntEnum.Mid),
        ]);
    });

    const { status, body } = await call("GET", "/dashboard/settings/budget", { as: adminA });
    expect(status).toBe(200);
    expect(body.spendingBudget).toEqual({
      budgetUsd: Schemas.DEFAULT_SPENDING_BUDGET_USD,
      isDefault: true,
      usedUsd: "1.250000",
      periodStart: periodStart.toISOString(),
      periodEnd: Schemas.budgetPeriodEnd(Schemas.budgetPeriodKey(now)).toISOString(),
    });
  });

  it("saves a new budget once, records nothing for the amount in force", async () => {
    for (const spendingBudgetUsd of [
      0,
      -5,
      10.005,
      1_000_000,
      Schemas.SPENDING_BUDGET_MAX_USD + 1,
    ]) {
      const refused = await call("PUT", "/dashboard/settings/budget", {
        as: adminA,
        body: { spendingBudgetUsd },
      });
      expect(refused.status).toBe(400);
    }

    // DEV_NOTE: The default saved explicitly is the budget already in force: nothing written, nothing recorded
    const pinned = await call("PUT", "/dashboard/settings/budget", {
      as: adminA,
      body: { spendingBudgetUsd: 10 },
    });
    expect(pinned.status).toBe(200);
    expect(pinned.body.spendingBudget?.isDefault).toBe(true);

    const saved = await call("PUT", "/dashboard/settings/budget", {
      as: adminA,
      body: { spendingBudgetUsd: 250.5 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.spendingBudget).toMatchObject({
      budgetUsd: "250.500000",
      isDefault: false,
      usedUsd: "1.250000",
    });
    await call("PUT", "/dashboard/settings/budget", {
      as: adminA,
      body: { spendingBudgetUsd: 250.5 },
    });

    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.Company)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.BudgetChanged,
        detail: { label: "$250.50" },
      },
    ]);

    const other = await call("GET", "/dashboard/settings/budget", { as: adminB });
    expect(other.body.spendingBudget).toMatchObject({ isDefault: true, usedUsd: "0.000000" });
    expect((await call("GET", "/dashboard/settings/budget", { as: operator })).status).toBe(403);
    expect(
      (
        await call("PUT", "/dashboard/settings/budget", {
          as: operator,
          body: { spendingBudgetUsd: 20 },
        })
      ).status,
    ).toBe(403);
  });

  // DEV_NOTE: The largest amount the numeric(12, 6) column holds in whole cents: saved, not a 500
  it("saves exactly the largest budget", async () => {
    const saved = await call("PUT", "/dashboard/settings/budget", {
      as: adminB,
      body: { spendingBudgetUsd: Schemas.SPENDING_BUDGET_MAX_USD },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.spendingBudget?.budgetUsd).toBe("999999.990000");
  });

  it("shows this page's writes in the audit log, in words", async () => {
    const { body } = await call("GET", "/dashboard/audit-log", { as: adminA });
    expect(
      (body.auditLog as Schemas.AuditLogEntry[] | undefined)?.map((entry) => [
        entry.actorName,
        entry.action,
        entry.on,
      ]),
    ).toEqual([
      ["Ana Ruiz", "Changed spending budget", "$250.50"],
      ["Ana Ruiz", "Rotated model key", "Anthropic"],
      ["Ana Ruiz", "Added model key", "Anthropic"],
    ]);
  });
});

describe("Settings › Connections API (M4-10)", { timeout: 60_000 }, () => {
  it("lists the connections production first, with their address and sign-in method", async () => {
    const { status, body, text } = await call("GET", "/dashboard/settings/connections", {
      as: adminA,
    });
    expect(status).toBe(200);
    expect(
      body.connections?.map((connection) => [
        connection.environmentLabel,
        connection.baseUrl,
        connection.signInLabel,
        connection.allowedOrigins,
      ]),
    ).toEqual([
      [
        "Production",
        "https://api.example.com/v1",
        "Forward the user's token",
        ["https://app.example.com"],
      ],
      [
        "Staging",
        "https://staging-api.example.com/v1",
        "Forward the user's token",
        ["https://app.example.com"],
      ],
    ]);
    expect(text).not.toContain("authConfig");

    const other = await call("GET", "/dashboard/settings/connections", { as: adminB });
    expect(other.body.connections).toEqual([]);
    expect((await call("GET", "/dashboard/settings/connections", { as: operator })).status).toBe(
      403,
    );
  });
});

describe("Settings › Team API (M4-10)", { timeout: 60_000 }, () => {
  async function inviteRows(companyId: string) {
    let rows: (typeof adminInvites.$inferSelect)[] = [];
    await withOwnerDb(async (ownerDb) => {
      rows = await ownerDb
        .select()
        .from(adminInvites)
        .where(eq(adminInvites.companyId, companyId))
        .orderBy(asc(adminInvites.id));
    });
    return rows;
  }

  it("lists the admins with when Clerk last saw them, and says so when it can't", async () => {
    const seenAt = Date.parse("2026-10-28T09:30:00.000Z");
    const lastActive = vi
      .spyOn(ClerkProvider, "getLastActive")
      .mockResolvedValue({ isSuccess: true, lastActiveAt: { [adminA]: seenAt, [adminA2]: null } });
    const { status, body } = await call("GET", "/dashboard/settings/team", { as: adminA });
    expect(status).toBe(200);
    expect(lastActive).toHaveBeenCalledWith(expect.anything(), [adminA, adminA2]);
    expect(
      body.team?.members.map(({ clerkUserId, name, isYou, lastActiveAt }) => ({
        clerkUserId,
        name,
        isYou,
        lastActiveAt,
      })),
    ).toEqual([
      {
        clerkUserId: adminA,
        name: "Ana Ruiz",
        isYou: true,
        lastActiveAt: new Date(seenAt).toISOString(),
      },
      { clerkUserId: adminA2, name: "Marcus Lee", isYou: false, lastActiveAt: null },
    ]);
    expect(body.team?.isLastActiveKnown).toBe(true);

    vi.spyOn(ClerkProvider, "getLastActive").mockResolvedValue({ isSuccess: false });
    const unknown = await call("GET", "/dashboard/settings/team", { as: adminA });
    expect(unknown.status).toBe(200);
    expect(unknown.body.team?.isLastActiveKnown).toBe(false);
    expect(unknown.body.team?.members).toHaveLength(2);

    expect((await call("GET", "/dashboard/settings/team", { as: operator })).status).toBe(403);
  });

  it("emails an invite to a new address once, and refuses an admin's email", async () => {
    const invitation = vi
      .spyOn(ClerkProvider, "createInvitation")
      .mockResolvedValue({ isSuccess: true, invitationId: "inv_new" });
    const invited = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "  Priya@Example.com " },
    });
    expect(invited.status).toBe(201);
    expect(invited.body.invite).toMatchObject({
      email: "priya@example.com",
      status: Schemas.AdminInviteStatusIntEnum.Pending,
      isEmailed: true,
    });
    const [row] = await inviteRows(companyA);
    expect(row).toMatchObject({
      email: "priya@example.com",
      clerkInvitationId: "inv_new",
      clerkUserId: null,
    });
    expect(invitation).toHaveBeenCalledWith(expect.anything(), {
      email: "priya@example.com",
      companyPublicId: expect.any(String),
      adminInvitePublicId: row!.publicId,
    });

    const again = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "priya@example.com" },
    });
    expect(again.status).toBe(409);
    expect(again.body.failure).toBe(Schemas.TeamFailureEnum.AlreadyInvited);
    // DEV_NOTE: Marcus is an admin here: matched whatever the case of the stored email
    const admin = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "marcus@example.com" },
    });
    expect(admin.status).toBe(409);
    expect(admin.body.failure).toBe(Schemas.TeamFailureEnum.AlreadyAdmin);
    expect(
      (
        await call("POST", "/dashboard/settings/team/invites", {
          as: adminA,
          body: { email: "nope" },
        })
      ).status,
    ).toBe(400);

    const listed = await call("GET", "/dashboard/settings/team", { as: adminA });
    expect(listed.body.team?.invites.map((invite) => invite.email)).toEqual(["priya@example.com"]);
    expect(listed.body.team?.invites[0]?.invitedByName).toBe("Ana Ruiz");
    expect(await inviteRows(companyA)).toHaveLength(1);
  });

  it("grants an existing account without email, and refuses one that is an admin anywhere", async () => {
    vi.spyOn(ClerkProvider, "findUserByEmail").mockResolvedValue({
      isSuccess: true,
      clerkUserId: existingClerkUser,
    });
    const grant = vi.spyOn(ClerkProvider, "grantInvite");
    const invitation = vi.spyOn(ClerkProvider, "createInvitation");
    const granted = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "returning@example.com" },
    });
    expect(granted.status).toBe(201);
    expect(granted.body.invite?.isEmailed).toBe(false);
    expect(grant).toHaveBeenCalledWith(expect.anything(), {
      clerkUserId: existingClerkUser,
      companyPublicId: expect.any(String),
      adminInvitePublicId: granted.body.invite?.publicId,
    });
    expect(invitation).not.toHaveBeenCalled();

    // DEV_NOTE: adminB administers company B: company A can't invite them
    vi.spyOn(ClerkProvider, "findUserByEmail").mockResolvedValue({
      isSuccess: true,
      clerkUserId: adminB,
    });
    const elsewhere = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "b-admin@example.com" },
    });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.failure).toBe(Schemas.TeamFailureEnum.AlreadyAdmin);
  });

  it("saves nothing when Clerk can't send the invite", async () => {
    vi.spyOn(ClerkProvider, "createInvitation").mockResolvedValue({
      isSuccess: false,
      message: "Unknown error in creating Clerk invitation",
    });
    const before = await inviteRows(companyA);
    const failed = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "later@example.com" },
    });
    expect(failed.status).toBe(502);
    expect(failed.body.failure).toBe(Schemas.TeamFailureEnum.ClerkUnavailable);
    expect(await inviteRows(companyA)).toHaveLength(before.length);
  });

  it("revokes a pending invite once, telling Clerk, never another company's", async () => {
    const [row] = await inviteRows(companyA);
    expect(
      (
        await call("POST", `/dashboard/settings/team/invites/${row!.publicId}/revoke`, {
          as: adminB,
        })
      ).status,
    ).toBe(404);

    const revoke = vi.spyOn(ClerkProvider, "revokeInvite");
    const revoked = await call("POST", `/dashboard/settings/team/invites/${row!.publicId}/revoke`, {
      as: adminA,
    });
    expect(revoked.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(expect.anything(), {
      clerkInvitationId: "inv_new",
      clerkUserId: null,
      adminInvitePublicId: row!.publicId,
    });
    expect((await inviteRows(companyA))[0]?.status).toBe(Schemas.AdminInviteStatusIntEnum.Revoked);

    const again = await call("POST", `/dashboard/settings/team/invites/${row!.publicId}/revoke`, {
      as: adminA,
    });
    expect(again.status).toBe(409);
    expect(again.body.failure).toBe(Schemas.TeamFailureEnum.NotPending);

    // DEV_NOTE: A revoked invite frees the email for a new one
    const reinvited = await call("POST", "/dashboard/settings/team/invites", {
      as: adminA,
      body: { email: "priya@example.com" },
    });
    expect(reinvited.status).toBe(201);
  });

  it("removes another admin, never yourself, and their next request is refused", async () => {
    const self = await call("DELETE", `/dashboard/settings/team/admins/${adminA}`, { as: adminA });
    expect(self.status).toBe(409);
    expect(self.body.failure).toBe(Schemas.TeamFailureEnum.CannotRemoveSelf);
    expect(
      (await call("DELETE", `/dashboard/settings/team/admins/${adminA2}`, { as: adminB })).status,
    ).toBe(404);

    const removed = await call("DELETE", `/dashboard/settings/team/admins/${adminA2}`, {
      as: adminA,
    });
    expect(removed.status).toBe(200);
    expect((await call("GET", "/dashboard/settings/team", { as: adminA2 })).status).toBe(403);
    expect(
      (await call("DELETE", `/dashboard/settings/team/admins/${adminA2}`, { as: adminA })).status,
    ).toBe(404);
  });

  it("records every team write in the audit log, in words", async () => {
    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.AdminInvite)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Created,
        detail: { label: "priya@example.com" },
      },
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Created,
        detail: { label: "returning@example.com" },
      },
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Revoked,
        detail: { label: "priya@example.com" },
      },
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Created,
        detail: { label: "priya@example.com" },
      },
    ]);
    expect(await auditEvents(companyA, Schemas.AuditEntityTypeEnum.Admin)).toEqual([
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Removed,
        detail: { label: "Marcus Lee" },
      },
    ]);
    const { body } = await call("GET", "/dashboard/audit-log", { as: adminA });
    expect(
      (body.auditLog as Schemas.AuditLogEntry[] | undefined)
        ?.slice(0, 2)
        .map((entry) => [entry.action, entry.on]),
    ).toEqual([
      ["Removed admin", "Marcus Lee"],
      ["Invited admin", "priya@example.com"],
    ]);
  });
});
