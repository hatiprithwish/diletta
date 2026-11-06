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
  chatbotConfigs,
  chatbots,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  evalCases,
  evalResults,
  evalRuns,
  eventOutbox,
} from "@/db/tables";
import worker from "@/index";
import { EvalRunnerEntrypoint } from "@/entrypoints/EvalRunnerEntrypoint";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import EvalRunnerRepo from "@/repositories/EvalRunnerRepo";
import Utility from "@/utils/Utility";
import { createKey, signToken } from "@/tests/helpers/widgetJwt";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Clerk stand-in. "Authorization: Bearer <clerkUserId>" signs in as that Clerk user; no header is signed out
vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: async (request: Request) => {
        const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!userId) return { isSignedIn: false, reason: "session-token-missing" };
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

// DEV_NOTE: The hosted eval runner's backend side (M7-9, ADR 0007) on the Neon staging branch through the whole worker
// (middleware → Repo as diletta_app): an operator sets a staging connection's test sign-in, a company admin starts a
// gate run (a Queued run, its audit row, the runner's Workflow started with public ids only), the runner reads the
// sign-in over its binding (EvalRunnerRepo, what EvalRunnerEntrypoint calls) and starts the queued run on /eval/runs.
// The Workflow binding is a fake: the runner itself is a Python Worker (apps/eval-runner). Fixtures and cleanup run as
// the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const FLOW_TIMEOUT_MS = 120_000;
const HOST_USER = "firebase-uid-eval";
const PASSWORD = `pw-${crypto.randomUUID()}`;
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const createdCompanyIds: string[] = [];
const workflowCreates: unknown[] = [];
let isWorkflowDown = false;
let ownerPool: Pool | null = null;
let evalKey: Awaited<ReturnType<typeof createKey>>;
let runnerEnv: Env;
let adminAId = "";

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

const LOGIN: Schemas.EvalHostLogin = {
  kind: Schemas.EvalHostLoginKindEnum.Eregister,
  hostUser: HOST_USER,
  firebaseApiKey: "web-api-key",
  email: "eval@example.com",
  password: PASSWORD,
};

type Tenant = Awaited<ReturnType<typeof createTenant>>;

// DEV_NOTE: A company (its key through CompaniesRepo) with one chatbot, a config of the given status, one active case,
// and a staging and a production connection
async function createTenant(configStatus: Schemas.ChatbotConfigStatusIntEnum) {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Eval runner ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const companyPublicId = created.company.publicId;

  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, companyPublicId));
    const companyId = company?.id ?? "";
    createdCompanyIds.push(companyId);

    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        name: "Records bot",
        isDefault: true,
      })
      .returning({ id: chatbots.id });
    const connectionColumns = {
      companyId,
      authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      authConfig: {},
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      allowedOrigins: ["https://app.example.com"],
    };
    const [staging] = await ownerDb
      .insert(companyConnections)
      .values({
        ...connectionColumns,
        publicId: Utility.generatePublicId(),
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: "https://staging.host.example.com/api/",
        jwtIssuer: `https://${crypto.randomUUID()}.staging.example.com`,
      })
      .returning({ id: companyConnections.id, publicId: companyConnections.publicId });
    const [production] = await ownerDb
      .insert(companyConnections)
      .values({
        ...connectionColumns,
        publicId: Utility.generatePublicId(),
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Production,
        baseUrl: "https://host.example.com/api/",
        jwtIssuer: `https://${crypto.randomUUID()}.production.example.com`,
      })
      .returning({ publicId: companyConnections.publicId });

    const normalized = Schemas.normalizeConfigBody({
      persona: { instructions: "You help the user keep their records up to date." },
      procedures: [],
      tools: [],
      approvalRules: [],
      routing: {
        small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
        mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
        top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-fable-5-1" },
        defaultTier: Schemas.ModelTierEnum.Mid,
      },
      knowledge: { sourceIds: [] },
      widget: { greeting: "Hi", suggestions: [] },
    });
    if (!normalized.body || !normalized.schemaVersion) throw new Error(normalized.message);
    const [config] = await ownerDb
      .insert(chatbotConfigs)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        chatbotId: chatbot?.id ?? "",
        configVersion: 1,
        schemaVersion: normalized.schemaVersion,
        status: configStatus,
        body: normalized.body,
        bodyHash: "runner-1",
      })
      .returning({ id: chatbotConfigs.id, publicId: chatbotConfigs.publicId });
    await ownerDb.insert(evalCases).values({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotId: chatbot?.id ?? "",
      name: "Answers politely",
      input: {
        schemaVersion: Schemas.EVAL_CASE_INPUT_SCHEMA_VERSION,
        messages: [{ role: "user", text: "Hello" }],
      },
      expectations: {
        schemaVersion: Schemas.EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
        rubric: null,
        rules: [{ kind: Schemas.EvalCaseRuleKindEnum.Contains, text: "Hello" }],
        toolCalls: [],
        forbiddenTools: [],
        readbacks: [],
      },
    });

    return {
      companyId,
      companyPublicId,
      configId: config?.id ?? "",
      configPublicId: config?.publicId ?? "",
      stagingId: staging?.id ?? "",
      stagingPublicId: staging?.publicId ?? "",
      productionPublicId: production?.publicId ?? "",
    };
  });
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; token?: string; hostToken?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.hostToken) headers[Schemas.EVAL_HOST_TOKEN_HEADER] = options.hostToken;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    runnerEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

// DEV_NOTE: An eval token for the tenant's staging connection, as the runner signs one
async function runnerToken(tenant: Tenant) {
  const now = Math.floor(Date.now() / 1000);
  return await signToken(evalKey, {
    iss: Schemas.EVAL_JWT_ISSUER,
    sub: HOST_USER,
    aud: Schemas.EVAL_JWT_AUDIENCE,
    iat: now,
    exp: now + 120,
    company: tenant.companyPublicId,
    connection: tenant.stagingPublicId,
  });
}

const loginPath = (tenant: Tenant, connectionPublicId: string) =>
  `/operator/companies/${tenant.companyPublicId}/connections/${connectionPublicId}/eval-login`;

async function runRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb.select().from(evalRuns).where(eq(evalRuns.publicId, publicId));
    return row;
  });
}

async function auditActions(companyId: string, entityType: Schemas.AuditEntityTypeEnum) {
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, entityType),
    ];
    const rows = await ownerDb
      .select({ entityAction: activityLog.entityAction, actorType: activityLog.actorType })
      .from(activityLog)
      .where(and(...conditions));
    return rows;
  });
}

let tenantA: Tenant;
let tenantB: Tenant;

beforeAll(async () => {
  evalKey = await createKey(Schemas.WidgetJwtAlgorithmEnum.ES256, `eval-${crypto.randomUUID()}`);
  const fakeWorkflow = {
    create: async (options: unknown) => {
      if (isWorkflowDown) throw new Error("runner down");
      workflowCreates.push(options);
      return { id: "instance" };
    },
  };
  runnerEnv = {
    ...env,
    EVAL_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [evalKey.jwk] }),
    EVAL_RUN_WORKFLOW: fakeWorkflow as unknown as Env["EVAL_RUN_WORKFLOW"],
  };
  tenantA = await createTenant(Schemas.ChatbotConfigStatusIntEnum.Testing);
  tenantB = await createTenant(Schemas.ChatbotConfigStatusIntEnum.Draft);
  await withOwnerDb(async (ownerDb) => {
    const inserted = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null },
        { clerkUserId: adminA, companyId: tenantA.companyId },
        { clerkUserId: adminB, companyId: tenantB.companyId },
      ])
      .returning({ id: admins.id, clerkUserId: admins.clerkUserId });
    adminAId = inserted.find((row) => row.clerkUserId === adminA)?.id ?? "";
  });
}, FLOW_TIMEOUT_MS);

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
      if (companyIds.length === 0) return;
      await ownerDb.delete(evalResults).where(inArray(evalResults.companyId, companyIds));
      await ownerDb.delete(evalRuns).where(inArray(evalRuns.companyId, companyIds));
      await ownerDb.delete(evalCases).where(inArray(evalCases.companyId, companyIds));
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
      await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
      await ownerDb
        .delete(companyConnections)
        .where(inArray(companyConnections.companyId, companyIds));
      await ownerDb
        .delete(companyEncryptionKeys)
        .where(inArray(companyEncryptionKeys.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

describe("Hosted eval runner (M7-9)", { timeout: FLOW_TIMEOUT_MS }, () => {
  it("lets an operator set a staging connection's test sign-in, never reading back its secrets", async () => {
    const body = { evalHostLogin: LOGIN };
    expect(
      (await call("PUT", loginPath(tenantA, tenantA.stagingPublicId), { as: adminA, body })).status,
    ).toBe(403);
    const production = await call("PUT", loginPath(tenantA, tenantA.productionPublicId), {
      as: operator,
      body,
    });
    expect(production.status).toBe(400);

    expect(
      (await call("GET", loginPath(tenantA, tenantA.stagingPublicId), { as: operator })).body,
    ).toMatchObject({
      isSuccess: true,
      evalHostLogin: null,
    });
    const saved = await call("PUT", loginPath(tenantA, tenantA.stagingPublicId), {
      as: operator,
      body,
    });
    expect(saved.status).toBe(200);
    // DEV_NOTE: Replaced in place: still one Active sign-in, one more audit row
    const replaced = await call("PUT", loginPath(tenantA, tenantA.stagingPublicId), {
      as: operator,
      body,
    });
    expect(replaced.status).toBe(200);
    const read = await call("GET", loginPath(tenantA, tenantA.stagingPublicId), { as: operator });
    expect(read.body).toMatchObject({
      evalHostLogin: {
        kind: Schemas.EvalHostLoginKindEnum.Eregister,
        kindLabel: Schemas.EvalHostLoginKindLabelEnum.Eregister,
        hostUser: HOST_USER,
      },
    });
    for (const answer of [saved, replaced, read]) {
      expect(answer.text).not.toContain(PASSWORD);
      expect(answer.text).not.toContain("web-api-key");
    }

    const stored = await withOwnerDb(async (ownerDb) =>
      ownerDb
        .select({ status: companySecrets.status, encryptedSecret: companySecrets.encryptedSecret })
        .from(companySecrets)
        .where(eq(companySecrets.connectionId, tenantA.stagingId)),
    );
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]!.encryptedSecret).toString("utf8")).not.toContain(PASSWORD);
    const audits = await auditActions(
      tenantA.companyId,
      Schemas.AuditEntityTypeEnum.CompanyConnection,
    );
    expect(
      audits.filter((row) => row.entityAction === Schemas.AuditEntityActionEnum.TestLoginSet),
    ).toEqual([
      {
        entityAction: Schemas.AuditEntityActionEnum.TestLoginSet,
        actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
      },
      {
        entityAction: Schemas.AuditEntityActionEnum.TestLoginSet,
        actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
      },
    ]);

    const summary = await call("GET", "/dashboard/eval-runs/summary", { as: adminA });
    expect(summary.body).toMatchObject({
      summary: { staging: { host: "staging.host.example.com", hasTestLogin: true } },
    });
  });

  it("refuses a gate run of a version that isn't Testing, and any run without a test sign-in", async () => {
    const gate = await call("POST", "/dashboard/eval-runs", {
      as: adminB,
      body: {
        chatbotConfigId: tenantB.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Gate,
      },
    });
    expect(gate.status).toBe(409);
    expect(gate.body.failure).toBe(Schemas.EvalRunStartFailureEnum.NotTesting);

    const manual = await call("POST", "/dashboard/eval-runs", {
      as: adminB,
      body: {
        chatbotConfigId: tenantB.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
      },
    });
    expect(manual.status).toBe(409);
    expect(manual.body.failure).toBe(Schemas.EvalRunStartFailureEnum.NoTestLogin);

    // DEV_NOTE: Another company's version is not found in the admin's own company
    const crossCompany = await call("POST", "/dashboard/eval-runs", {
      as: adminB,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Gate,
      },
    });
    expect(crossCompany.status).toBe(404);
  });

  it("queues a gate run, hands the runner public ids only, then starts it on /eval/runs with its own k", async () => {
    workflowCreates.length = 0;
    const started = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Gate,
      },
    });
    expect(started.status).toBe(201);
    const runPublicId = (started.body.evalRun as { publicId: string }).publicId;
    expect(workflowCreates).toEqual([
      {
        id: runPublicId,
        params: { companyPublicId: tenantA.companyPublicId, runPublicId, resumedCount: 0 },
      },
    ]);
    expect(await runRow(runPublicId)).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Queued,
      trigger: Schemas.EvalRunTriggerIntEnum.Gate,
      k: Schemas.EVAL_GATE_MIN_K,
      startedBy: adminAId,
      companyConnectionId: tenantA.stagingId,
      evalCaseIds: null,
    });
    const audits = await auditActions(tenantA.companyId, Schemas.AuditEntityTypeEnum.ChatbotConfig);
    expect(audits).toContainEqual({
      entityAction: Schemas.AuditEntityActionEnum.GateRunStarted,
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
    });

    const again = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
      },
    });
    expect(again.status).toBe(409);
    expect(again.body.failure).toBe(Schemas.EvalRunStartFailureEnum.AlreadyRunning);

    // DEV_NOTE: The runner's binding: the decrypted sign-in for this run, and nothing for another company's name
    const repo = new EvalRunnerRepo(runnerEnv);
    const login = await repo.getRunLogin({ companyPublicId: tenantA.companyPublicId, runPublicId });
    expect(login.runLogin).toEqual({
      companyPublicId: tenantA.companyPublicId,
      connectionPublicId: tenantA.stagingPublicId,
      login: LOGIN,
    });
    const crossCompany = await repo.getRunLogin({
      companyPublicId: tenantB.companyPublicId,
      runPublicId,
    });
    expect(crossCompany).toMatchObject({ isSuccess: false, isNotFound: true });

    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(evalKey, {
      iss: Schemas.EVAL_JWT_ISSUER,
      sub: HOST_USER,
      aud: Schemas.EVAL_JWT_AUDIENCE,
      iat: now,
      exp: now + 120,
      company: tenantA.companyPublicId,
      connection: tenantA.stagingPublicId,
    });
    const body = { runId: runPublicId, harnessVersion: "runner-1" };
    const running = await call("POST", "/eval/runs", { token, body });
    expect(running.status).toBe(201);
    expect(running.body).toMatchObject({
      run: { publicId: runPublicId, k: Schemas.EVAL_GATE_MIN_K },
    });
    const row = await runRow(runPublicId);
    expect(row).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Running,
      harnessVersion: "runner-1",
    });
    expect(row?.evalCaseIds?.length).toBeGreaterThan(0);
    const repeat = await call("POST", "/eval/runs", { token, body });
    expect(repeat.status).toBe(409);

    // DEV_NOTE: A started run is the runner's own to finish: failQueuedRun leaves it Running
    await repo.failQueuedRun({
      companyPublicId: tenantA.companyPublicId,
      runPublicId,
      failure: Schemas.EvalRunFailureIntEnum.HarnessError,
    });
    expect((await runRow(runPublicId))?.status).toBe(Schemas.EvalRunStatusIntEnum.Running);
    await withOwnerDb(async (ownerDb) =>
      ownerDb
        .update(evalRuns)
        .set({ status: Schemas.EvalRunStatusIntEnum.Failed })
        .where(eq(evalRuns.publicId, runPublicId)),
    );
  });

  it("fails the run when the runner can't take it, and when it can't start it", async () => {
    isWorkflowDown = true;
    const refused = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
      },
    });
    isWorkflowDown = false;
    expect(refused.status).toBe(503);
    expect(refused.body.failure).toBe(Schemas.EvalRunStartFailureEnum.RunnerUnavailable);
    const failed = await withOwnerDb(async (ownerDb) =>
      ownerDb
        .select({ status: evalRuns.status, failure: evalRuns.failure })
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.companyId, tenantA.companyId),
            eq(evalRuns.failure, Schemas.EvalRunFailureIntEnum.RunnerUnavailable),
          ),
        ),
    );
    expect(failed).toEqual([
      {
        status: Schemas.EvalRunStatusIntEnum.Failed,
        failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
      },
    ]);

    const queued = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
      },
    });
    expect(queued.status).toBe(201);
    const runPublicId = (queued.body.evalRun as { publicId: string }).publicId;
    expect(await runRow(runPublicId)).toMatchObject({
      k: 1,
      trigger: Schemas.EvalRunTriggerIntEnum.Manual,
    });
    const repo = new EvalRunnerRepo(runnerEnv);
    // DEV_NOTE: The runner names the stop it hit (here the host test user's sign-in), so the run page says why
    expect(
      (
        await repo.failQueuedRun({
          companyPublicId: tenantA.companyPublicId,
          runPublicId,
          failure: Schemas.EvalRunFailureIntEnum.HostUnavailable,
        })
      ).isSuccess,
    ).toBe(true);
    expect(await runRow(runPublicId)).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Failed,
      failure: Schemas.EvalRunFailureIntEnum.HostUnavailable,
    });
    // DEV_NOTE: An ended run's sign-in is never handed out again
    expect(
      await repo.getRunLogin({ companyPublicId: tenantA.companyPublicId, runPublicId }),
    ).toMatchObject({
      isNotFound: true,
    });
  });

  it("fails a run left Queued past the stale limit instead of blocking the version", async () => {
    const start = () =>
      call("POST", "/dashboard/eval-runs", {
        as: adminA,
        body: {
          chatbotConfigId: tenantA.configPublicId,
          trigger: Schemas.EvalRunTriggerIntEnum.Manual,
        },
      });
    const first = await start();
    expect(first.status).toBe(201);
    const firstId = (first.body.evalRun as { publicId: string }).publicId;
    expect((await start()).body.failure).toBe(Schemas.EvalRunStartFailureEnum.AlreadyRunning);

    const staleAt = new Date(Date.now() - (Schemas.EVAL_RUN_QUEUED_STALE_MINUTES + 1) * 60_000);
    await withOwnerDb(async (ownerDb) =>
      ownerDb
        .update(evalRuns)
        .set({ createdAt: staleAt, updatedAt: staleAt })
        .where(eq(evalRuns.publicId, firstId)),
    );
    const second = await start();
    expect(second.status).toBe(201);
    expect(await runRow(firstId)).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Failed,
      failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
    });
    const secondId = (second.body.evalRun as { publicId: string }).publicId;

    // DEV_NOTE: A Running run counts from its last change (each model call's cost moves updated_at), not its start
    const runningSince = (minutes: number) =>
      withOwnerDb(async (ownerDb) =>
        ownerDb
          .update(evalRuns)
          .set({
            status: Schemas.EvalRunStatusIntEnum.Running,
            createdAt: new Date(Date.now() - 2 * Schemas.EVAL_RUN_RUNNING_STALE_MINUTES * 60_000),
            updatedAt: new Date(Date.now() - minutes * 60_000),
          })
          .where(eq(evalRuns.publicId, secondId)),
      );
    await runningSince(Schemas.EVAL_RUN_RUNNING_STALE_MINUTES - 1);
    expect((await start()).body.failure).toBe(Schemas.EvalRunStartFailureEnum.AlreadyRunning);
    await runningSince(Schemas.EVAL_RUN_RUNNING_STALE_MINUTES + 1);
    const third = await start();
    expect(third.status).toBe(201);
    expect(await runRow(secondId)).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Failed,
      failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
    });
    await new EvalRunnerRepo(runnerEnv).failQueuedRun({
      companyPublicId: tenantA.companyPublicId,
      runPublicId: (third.body.evalRun as { publicId: string }).publicId,
      failure: Schemas.EvalRunFailureIntEnum.RunnerUnavailable,
    });
  });

  it("serves the runner's /eval/runs calls over the binding, and nothing else", async () => {
    const ctx = createExecutionContext();
    const entrypoint = new EvalRunnerEntrypoint(ctx, runnerEnv);
    const unsigned = await entrypoint.fetch(
      new Request("https://backend.internal/eval/runs", { method: "POST", body: "{}" }),
    );
    expect(unsigned.status).toBe(401);
    for (const path of ["/dashboard/me", "/eval/load/start", "/eval/runsx"]) {
      const refused = await entrypoint.fetch(new Request(`https://backend.internal${path}`));
      expect(refused.status).toBe(404);
    }
    await waitOnExecutionContext(ctx);
  });

  it("resumes a run that stopped on the way, keeping its results, and leaves its version in testing", async () => {
    const started = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Gate,
      },
    });
    expect(started.status).toBe(201);
    const runPublicId = (started.body.evalRun as { publicId: string }).publicId;
    const token = await runnerToken(tenantA);
    const first = await call("POST", "/eval/runs", {
      token,
      body: { runId: runPublicId, harnessVersion: "runner-1" },
    });
    expect(first.status).toBe(201);
    expect(first.body.doneAttempts).toEqual([]);
    const cases = first.body.cases as { publicId: string }[];
    const [firstCase] = cases;
    if (!firstCase) throw new Error("The run has no case");
    const run = await runRow(runPublicId);
    const [caseRow] = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ id: evalCases.id })
        .from(evalCases)
        .where(eq(evalCases.publicId, firstCase.publicId)),
    );
    // DEV_NOTE: One attempt got its result before the run stopped (no transcript: none is needed here)
    await withOwnerDb((ownerDb) =>
      ownerDb.insert(evalResults).values({
        companyId: tenantA.companyId,
        evalRunId: run?.id ?? "",
        evalCaseId: caseRow?.id ?? "",
        attempt: 1,
        hasPassed: true,
      }),
    );
    const stopped = await call("POST", `/eval/runs/${runPublicId}/finish`, {
      token,
      body: { isComplete: false, failure: Schemas.EvalRunFailureIntEnum.HostUnavailable },
    });
    expect(stopped.status).toBe(200);
    // DEV_NOTE: A gate run that stopped on the way isn't a verdict: the version stays in testing
    const [config] = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(chatbotConfigs).where(eq(chatbotConfigs.id, tenantA.configId)),
    );
    expect(config?.status).toBe(Schemas.ChatbotConfigStatusIntEnum.Testing);

    const page = await call("GET", `/dashboard/eval-runs/${runPublicId}`, { as: adminA });
    expect(page.body.runActions).toEqual({ canResume: true, failedCaseCount: cases.length });

    workflowCreates.length = 0;
    const resumed = await call("POST", `/dashboard/eval-runs/${runPublicId}/resume`, {
      as: adminA,
    });
    expect(resumed.status).toBe(200);
    expect(workflowCreates).toEqual([
      {
        id: `${runPublicId}-r1`,
        params: { companyPublicId: tenantA.companyPublicId, runPublicId, resumedCount: 1 },
      },
    ]);
    expect(await runRow(runPublicId)).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Queued,
      failure: null,
      resumedCount: 1,
      evalCaseIds: run?.evalCaseIds,
    });
    const audits = await auditActions(tenantA.companyId, Schemas.AuditEntityTypeEnum.ChatbotConfig);
    expect(audits).toContainEqual({
      entityAction: Schemas.AuditEntityActionEnum.RunResumed,
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
    });
    const twice = await call("POST", `/dashboard/eval-runs/${runPublicId}/resume`, { as: adminA });
    expect(twice.status).toBe(409);
    expect(twice.body.failure).toBe(Schemas.EvalRunStartFailureEnum.NotResumable);

    // DEV_NOTE: The runner starts it again: the same cases, the attempt with a result handed back and never run again
    const again = await call("POST", "/eval/runs", {
      token,
      body: { runId: runPublicId, harnessVersion: "runner-1" },
    });
    expect(again.status).toBe(201);
    expect((again.body.cases as { publicId: string }[]).map((c) => c.publicId)).toEqual(
      cases.map((c) => c.publicId),
    );
    expect(again.body.doneAttempts).toEqual([{ caseId: firstCase.publicId, attempt: 1 }]);
    expect((await runRow(runPublicId))?.evalCaseIds).toEqual(run?.evalCaseIds);
    const rerun = await call("POST", `/eval/runs/${runPublicId}/attempts`, {
      token,
      hostToken: "host-token",
      body: { caseId: firstCase.publicId, attempt: 1, messages: [{ role: "user", text: "Hi" }] },
    });
    expect(rerun.status).toBe(409);
    expect(rerun.body.failure).toBe(Schemas.EvalRunStepFailureEnum.Duplicate);

    await call("POST", `/eval/runs/${runPublicId}/finish`, { token, body: { isComplete: false } });
  });

  it("runs only a run's failed cases, as a manual run that holds them", async () => {
    const [stoppedRun] = await withOwnerDb((ownerDb) =>
      ownerDb
        .select()
        .from(evalRuns)
        .where(and(eq(evalRuns.companyId, tenantA.companyId), eq(evalRuns.resumedCount, 1))),
    );
    if (!stoppedRun) throw new Error("No resumed run");
    const gate = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Gate,
        failedCasesOfRunId: stoppedRun.publicId,
      },
    });
    expect(gate.status).toBe(400);

    const started = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
        failedCasesOfRunId: stoppedRun.publicId,
      },
    });
    expect(started.status).toBe(201);
    const runPublicId = (started.body.evalRun as { publicId: string }).publicId;
    const queued = await runRow(runPublicId);
    // DEV_NOTE: k = 3 for the gate and one pass recorded: every case of the set still failed, so all of them run
    expect([...(queued?.evalCaseIds ?? [])].sort()).toEqual(
      [...(stoppedRun.evalCaseIds ?? [])].sort(),
    );
    const token = await runnerToken(tenantA);
    const first = await call("POST", "/eval/runs", {
      token,
      body: { runId: runPublicId, harnessVersion: "runner-1" },
    });
    expect(first.status).toBe(201);
    expect((first.body.cases as unknown[]).length).toBe(stoppedRun.evalCaseIds?.length);
    expect(first.body.doneAttempts).toEqual([]);
    await call("POST", `/eval/runs/${runPublicId}/finish`, { token, body: { isComplete: false } });

    // DEV_NOTE: Another chatbot's run, or one with nothing that failed, starts nothing
    const crossCompany = await call("POST", "/dashboard/eval-runs", {
      as: adminB,
      body: {
        chatbotConfigId: tenantB.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
        failedCasesOfRunId: stoppedRun.publicId,
      },
    });
    expect(crossCompany.status).toBe(404);
  });

  it("removes the test sign-in, after which no run can start", async () => {
    const removed = await call("DELETE", loginPath(tenantA, tenantA.stagingPublicId), {
      as: operator,
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ isSuccess: true, evalHostLogin: null });
    const again = await call("DELETE", loginPath(tenantA, tenantA.stagingPublicId), {
      as: operator,
    });
    expect(again.status).toBe(200);
    const audits = await auditActions(
      tenantA.companyId,
      Schemas.AuditEntityTypeEnum.CompanyConnection,
    );
    expect(
      audits.filter((row) => row.entityAction === Schemas.AuditEntityActionEnum.TestLoginRemoved),
    ).toHaveLength(1);

    const summary = await call("GET", "/dashboard/eval-runs/summary", { as: adminA });
    expect(summary.body).toMatchObject({ summary: { staging: { hasTestLogin: false } } });
    const refused = await call("POST", "/dashboard/eval-runs", {
      as: adminA,
      body: {
        chatbotConfigId: tenantA.configPublicId,
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
      },
    });
    expect(refused.body.failure).toBe(Schemas.EvalRunStartFailureEnum.NoTestLogin);
  });
});
