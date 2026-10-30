import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  changeRequests,
  chatbotConfigs,
  chatbotUsers,
  chatbots,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  conversations,
  evalCases,
  evalResults,
  evalRuns,
  eventOutbox,
  messages,
  modelCalls,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import worker from "@/index";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import DashboardConversationsRepo from "@/repositories/DashboardConversationsRepo";
import EvalJwtProvider from "@/providers/evalJwt";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import EvalAuthRepo from "@/repositories/EvalAuthRepo";
import Utility from "@/utils/Utility";
import {
  anthropicReplyStream,
  anthropicToolCallsStream,
  gatewayRequests,
  mockCloudflare,
  mockedRequests,
} from "@/tests/helpers/gateway";
import {
  mintTestHostTokens,
  newTestHostWorkspace,
  render,
  resetTestHost,
  routeTestHostFetch,
  testHostAdapter,
  testHostIssuer,
  testHostTool,
  testHostToolColumns,
} from "@/tests/helpers/testHost";
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

// DEV_NOTE: The eval harness API end to end (M5-2): a platform-signed eval JWT (a key generated per run, its JWKS
// passed as EVAL_JWT_PUBLIC_JWKS in the env each request gets), /eval/* through the worker, the Conversation DO over
// RPC, Neon staging as diletta_app, and the real test host (auxiliary worker) behind the adapter. Each company has a
// staging connection on the test host (with its reset_op) and a production connection whose base URL reaches nothing:
// its tool versions are bound to the production one, so a passing attempt proves the eval ran them on staging. The
// config under test is a Draft. The model is scripted (AI Gateway mocked). afterAll deletes every row it created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const END_TO_END_TIMEOUT_MS = 120_000;
const PRODUCTION_BASE_URL = "https://production.unreachable.invalid/v1/";
const HOST_USER = "eval-test-user";
const createdCompanyIds: string[] = [];
let ownerPool: Pool | null = null;
let evalKey: Awaited<ReturnType<typeof createKey>>;
let evalEnv: Env;

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

type Tenant = Awaited<ReturnType<typeof createTenant>>;

async function createTenant() {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Eval test ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const companyPublicId = created.company.publicId;

  const tenant = await withOwnerDb(async (ownerDb) => {
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
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
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
        baseUrl: Schemas.getTestHostBaseUrl(testHostIssuer),
        jwtIssuer: `https://${crypto.randomUUID()}.staging.example.com`,
        resetOp: Schemas.TEST_HOST_RESET_OP,
      })
      .returning({ id: companyConnections.id, publicId: companyConnections.publicId });
    const [production] = await ownerDb
      .insert(companyConnections)
      .values({
        ...connectionColumns,
        publicId: Utility.generatePublicId(),
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Production,
        baseUrl: PRODUCTION_BASE_URL,
        jwtIssuer: `https://${crypto.randomUUID()}.production.example.com`,
      })
      .returning({ id: companyConnections.id, publicId: companyConnections.publicId });
    for (const name of ["get_record", "update_record"]) {
      await ownerDb.insert(toolDefinitions).values({
        publicId: Utility.generatePublicId(),
        companyId,
        connectionId: production?.id ?? "",
        version: 1,
        status: Schemas.ToolDefinitionStatusIntEnum.Active,
        ...testHostToolColumns(name),
      });
    }

    const normalized = Schemas.normalizeConfigBody({
      persona: { instructions: "You help the user keep their records up to date." },
      procedures: [],
      tools: [
        { name: "get_record", version: 1 },
        { name: "update_record", version: 1 },
      ],
      approvalRules: [],
      routing: {
        small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
        mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
        top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
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
        status: Schemas.ChatbotConfigStatusIntEnum.Draft,
        body: normalized.body,
        bodyHash: "eval-1",
      })
      .returning({ id: chatbotConfigs.id, publicId: chatbotConfigs.publicId });

    const expectations: Schemas.EvalCaseExpectations = {
      schemaVersion: Schemas.EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
      rubric: null,
      rules: [{ kind: Schemas.EvalCaseRuleKindEnum.Contains, text: "300" }],
      toolCalls: [{ toolName: "update_record", args: { recordId: "rec_alpha", amount: 300 } }],
      forbiddenTools: [],
      readbacks: [{ toolName: "update_record", expect: { amount: 300 } }],
    };
    const [evalCase] = await ownerDb
      .insert(evalCases)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        chatbotId: chatbot?.id ?? "",
        name: "Updates Alpha's amount",
        input: {
          schemaVersion: Schemas.EVAL_CASE_INPUT_SCHEMA_VERSION,
          messages: [
            {
              role: "user",
              text: `Set Alpha's amount to 300 (${Schemas.EVAL_CASE_TAG_PLACEHOLDER})`,
            },
          ],
        },
        expectations,
      })
      .returning({ id: evalCases.id, publicId: evalCases.publicId });

    return {
      companyId,
      companyPublicId,
      chatbotId: chatbot?.id ?? "",
      chatbotPublicId: chatbot?.publicId ?? "",
      configId: config?.id ?? "",
      configPublicId: config?.publicId ?? "",
      stagingPublicId: staging?.publicId ?? "",
      productionPublicId: production?.publicId ?? "",
      casePublicId: evalCase?.publicId ?? "",
    };
  });

  await new CompanySecretsRepo(env).createCompanySecret({
    companyId: tenant.companyId,
    connectionId: null,
    companySecret: {
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider: Schemas.ModelProviderEnum.Anthropic,
      secret: `sk-ant-${crypto.randomUUID()}`,
      expiresAt: null,
    },
  });

  const workspace = newTestHostWorkspace();
  const { hostToken } = await mintTestHostTokens(workspace, { sub: HOST_USER });
  await resetTestHost(hostToken);
  return { ...tenant, hostToken };
}

function evalClaims(tenant: Tenant, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: Schemas.EVAL_JWT_ISSUER,
    sub: HOST_USER,
    aud: Schemas.EVAL_JWT_AUDIENCE,
    iat: now,
    exp: now + 120,
    company: tenant.companyPublicId,
    connection: tenant.stagingPublicId,
    ...overrides,
  };
}

async function call(
  path: string,
  options: { token: string | null; body?: unknown; hostToken?: string },
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.hostToken) headers[Schemas.EVAL_HOST_TOKEN_HEADER] = options.hostToken;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://localhost/eval${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {}),
    }),
    evalEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const tokenFor = async (tenant: Tenant, overrides: Record<string, unknown> = {}) =>
  await signToken(evalKey, evalClaims(tenant, overrides));

async function startRun(tenant: Tenant, k = 1) {
  const response = await call("/runs", {
    token: await tokenFor(tenant),
    body: {
      chatbotConfigId: tenant.configPublicId,
      k,
      harnessVersion: "test-1",
      trigger: Schemas.EvalRunTriggerIntEnum.Manual,
    },
  });
  expect(response.status).toBe(201);
  return Schemas.ZCreateEvalRunApiResponse.parse(await response.json());
}

// DEV_NOTE: The model's answers, in order; any request past the script gets a plain reply
function scriptModel(script: ((model: string) => Response)[]) {
  let count = 0;
  mockCloudflare((mocked) => {
    const model = String(mocked.body?.model);
    const next = script[count];
    count += 1;
    return next ? next(model) : anthropicReplyStream(model, "Done.");
  });
}

const updateAlpha = (amount: number) => (model: string) =>
  anthropicToolCallsStream(model, [
    {
      id: `toolu_${crypto.randomUUID()}`,
      name: "update_record",
      input: { recordId: "rec_alpha", amount },
    },
  ]);
const reply = (text: string) => (model: string) => anthropicReplyStream(model, text);

async function runAttempt(tenant: Tenant, runId: string, attempt = 1) {
  return await call(`/runs/${runId}/attempts`, {
    token: await tokenFor(tenant),
    hostToken: tenant.hostToken,
    body: {
      caseId: tenant.casePublicId,
      attempt,
      messages: [{ role: "user", text: `Set Alpha's amount to 300 (tag-${attempt})` }],
    },
  });
}

async function readAlpha(hostToken: string) {
  const adapter = testHostAdapter(() => hostToken);
  const response = await adapter.readback({
    request: render(testHostTool("get_record").ops.callOp, { args: { recordId: "rec_alpha" } }),
  });
  return (response.body as { data?: Record<string, unknown> } | undefined)?.data;
}

const graderOutput = (hasPassed: boolean): Schemas.EvalGraderOutput => ({
  schemaVersion: Schemas.EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
  checks: [
    {
      kind: Schemas.EvalCheckKindEnum.ToolCall,
      hasPassed,
      label: "Called update_record",
      detail: null,
    },
  ],
  error: null,
});

// DEV_NOTE: Records a result for every case of the run but the ones skipped (a passing one for the tenant's own case)
async function recordAll(
  tenant: Tenant,
  started: Schemas.CreateEvalRunApiResponse,
  skip: string[] = [],
): Promise<void> {
  for (const evalCase of started.cases) {
    if (skip.includes(evalCase.publicId)) continue;
    for (let attempt = 1; attempt <= started.run.k; attempt += 1) {
      const recorded = await call(`/runs/${started.run.publicId}/results`, {
        token: await tokenFor(tenant),
        body: {
          caseId: evalCase.publicId,
          attempt,
          hasPassed: true,
          graderOutput: graderOutput(true),
          latencyMs: null,
        },
      });
      expect(recorded.status).toBe(201);
    }
  }
}

// DEV_NOTE: Another case of the tenant's chatbot, active
async function addCase(tenant: Tenant): Promise<string> {
  return await withOwnerDb(async (ownerDb) => {
    const [evalCase] = await ownerDb
      .insert(evalCases)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        chatbotId: tenant.chatbotId,
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
      })
      .returning({ publicId: evalCases.publicId });
    return evalCase?.publicId ?? "";
  });
}

beforeAll(async () => {
  evalKey = await createKey(Schemas.WidgetJwtAlgorithmEnum.ES256, `eval-${crypto.randomUUID()}`);
  evalEnv = { ...env, EVAL_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [evalKey.jwk] }) };
});

afterEach(() => {
  vi.restoreAllMocks();
  mockedRequests.length = 0;
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(evalResults).where(inArray(evalResults.companyId, companyIds));
      await ownerDb.delete(evalRuns).where(inArray(evalRuns.companyId, companyIds));
      await ownerDb.delete(evalCases).where(inArray(evalCases.companyId, companyIds));
      await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
      await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
      await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
      await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
      await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
      await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
      await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
      await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
      await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
      await ownerDb
        .delete(companyConnections)
        .where(inArray(companyConnections.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb
        .delete(companyEncryptionKeys)
        .where(inArray(companyEncryptionKeys.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

describe("EvalJwtProvider", () => {
  it("accepts only the eval audience and a lifetime of at most five minutes", () => {
    const now = 1_800_000_000;
    const claims = {
      iss: Schemas.EVAL_JWT_ISSUER as typeof Schemas.EVAL_JWT_ISSUER,
      sub: HOST_USER,
      aud: Schemas.EVAL_JWT_AUDIENCE,
      iat: now,
      exp: now + 120,
      company: "c",
      connection: "k",
    };
    expect(EvalJwtProvider.checkClaims(claims, now).isSuccess).toBe(true);
    expect(
      EvalJwtProvider.checkClaims({ ...claims, aud: Schemas.WIDGET_JWT_AUDIENCE }, now).failure,
    ).toBe(Schemas.EvalAuthFailureEnum.Unauthorized);
    expect(EvalJwtProvider.checkClaims({ ...claims, exp: now + 600 }, now).isSuccess).toBe(false);
    expect(EvalJwtProvider.checkClaims(claims, now + 600).isSuccess).toBe(false);
  });

  it("refuses an algorithm other than ES256 and a token with no signature", () => {
    expect(EvalJwtProvider.decode("a.b").isSuccess).toBe(false);
    const header = btoa(JSON.stringify({ alg: "HS256", kid: "k" }));
    expect(EvalJwtProvider.decode(`${header}.e30.c2ln`).isSuccess).toBe(false);
  });
});

describe("Eval auth", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  it("answers 401 without a valid platform signature, 403 for a production or unknown connection", async () => {
    const tenant = await createTenant();
    const body = {
      chatbotConfigId: tenant.configPublicId,
      k: 1,
      harnessVersion: "test-1",
      trigger: Schemas.EvalRunTriggerIntEnum.Manual,
    };
    expect((await call("/runs", { token: null, body })).status).toBe(401);

    // DEV_NOTE: Signed by a key the worker doesn't list (a host's own key, say)
    const otherKey = await createKey(Schemas.WidgetJwtAlgorithmEnum.ES256, evalKey.kid);
    const forged = await signToken(otherKey, evalClaims(tenant));
    expect((await call("/runs", { token: forged, body })).status).toBe(401);

    const expired = await tokenFor(tenant, {
      iat: Math.floor(Date.now() / 1000) - 600,
      exp: Math.floor(Date.now() / 1000) - 300,
    });
    expect((await call("/runs", { token: expired, body })).status).toBe(401);

    const production = await tokenFor(tenant, { connection: tenant.productionPublicId });
    const refused = await call("/runs", { token: production, body });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      isSuccess: false,
      failure: Schemas.EvalAuthFailureEnum.Forbidden,
    });

    const unknown = await tokenFor(tenant, { connection: Utility.generatePublicId() });
    expect((await call("/runs", { token: unknown, body })).status).toBe(403);

    // DEV_NOTE: Authenticated before validated: a bad body with no token is still 401
    expect((await call("/runs", { token: null, body: { k: 99 } })).status).toBe(401);
    expect((await call("/runs", { token: await tokenFor(tenant), body: { k: 99 } })).status).toBe(
      400,
    );
  });
});

describe("Eval run on the test host", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  it("runs an attempt of the draft config on the staging connection, reads it back, records, resets and finishes", async () => {
    const tenant = await createTenant();
    const started = await startRun(tenant);
    expect(started.run.k).toBe(1);
    // DEV_NOTE: Every active platform case joins the run too (other suites may have some in place meanwhile)
    const ownCase = started.cases.find((evalCase) => evalCase.publicId === tenant.casePublicId);
    expect(ownCase?.expectations.readbacks).toEqual([
      { toolName: "update_record", expect: { amount: 300 } },
    ]);
    const runId = started.run.publicId;

    scriptModel([updateAlpha(300), reply("Done: Alpha's amount is now 300.")]);
    routeTestHostFetch();
    const response = await runAttempt(tenant, runId);
    expect(response.status).toBe(200);
    const attempt = Schemas.ZRunEvalAttemptApiResponse.parse(await response.json());
    expect(attempt.turnStatus).toBe(Schemas.EvalTurnStatusEnum.Completed);
    expect(attempt.reply).toBe("Done: Alpha's amount is now 300.");
    // DEV_NOTE: Approved without a user and verified in the turn, on the staging connection (the tool's own,
    // production, reaches nothing)
    expect(attempt.toolCalls).toHaveLength(1);
    const [write] = attempt.toolCalls;
    expect(write).toMatchObject({
      toolName: "update_record",
      args: { recordId: "rec_alpha", amount: 300 },
      status: Schemas.HostToolStatusEnum.Verified,
    });
    expect(write?.changeRequestId).toEqual(expect.any(String));
    expect((await readAlpha(tenant.hostToken))?.amount).toBe(300);

    // DEV_NOTE: The conversation is the run's, pinned to the draft config; its model calls carry the run
    const [conversation] = await withOwnerDb((ownerDb) =>
      ownerDb
        .select()
        .from(conversations)
        .where(eq(conversations.publicId, attempt.conversationId)),
    );
    const [run] = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(evalRuns).where(eq(evalRuns.publicId, runId)),
    );
    expect(conversation?.evalRunId).toBe(run?.id);
    expect(conversation?.chatbotConfigId).toBe(tenant.configId);
    const calls = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(modelCalls).where(eq(modelCalls.companyId, tenant.companyId)),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((row) => row.evalRunId === run?.id)).toBe(true);
    expect(gatewayRequests()[0]?.headers.get("cf-aig-metadata")).toContain(run?.id ?? "");

    // DEV_NOTE: An eval chat is never on the dashboard
    const listed = await new DashboardConversationsRepo(env).getConversations({
      companyId: tenant.companyId,
    });
    expect(listed.totalRecords).toBe(0);

    const readbackBody = (amount: number) => ({
      conversationId: attempt.conversationId,
      changeRequestId: write?.changeRequestId,
      readback: { toolName: "update_record", expect: { amount } },
    });
    const matched = await call(`/runs/${runId}/readbacks`, {
      token: await tokenFor(tenant),
      hostToken: tenant.hostToken,
      body: readbackBody(300),
    });
    expect(matched.status).toBe(200);
    expect(Schemas.ZEvalReadbackApiResponse.parse(await matched.json())).toMatchObject({
      verdict: Schemas.EvalReadbackVerdictEnum.Matches,
      fields: [{ name: "amount", isMatch: true, expected: 300, found: 300, isFound: true }],
    });
    const differed = await call(`/runs/${runId}/readbacks`, {
      token: await tokenFor(tenant),
      hostToken: tenant.hostToken,
      body: readbackBody(301),
    });
    expect(Schemas.ZEvalReadbackApiResponse.parse(await differed.json()).verdict).toBe(
      Schemas.EvalReadbackVerdictEnum.Differs,
    );
    const otherTool = await call(`/runs/${runId}/readbacks`, {
      token: await tokenFor(tenant),
      hostToken: tenant.hostToken,
      body: { ...readbackBody(300), readback: { toolName: "get_record", expect: { amount: 300 } } },
    });
    expect(otherTool.status).toBe(400);

    const result = (attemptNo: number) => ({
      caseId: tenant.casePublicId,
      attempt: attemptNo,
      hasPassed: true,
      graderOutput: graderOutput(true),
      latencyMs: attempt.latencyMs,
    });
    const recorded = await call(`/runs/${runId}/results`, {
      token: await tokenFor(tenant),
      body: result(1),
    });
    expect(recorded.status).toBe(201);
    await recordAll(tenant, started, [tenant.casePublicId]);
    const duplicate = await call(`/runs/${runId}/results`, {
      token: await tokenFor(tenant),
      body: result(1),
    });
    expect(duplicate.status).toBe(409);
    const pastK = await call(`/runs/${runId}/results`, {
      token: await tokenFor(tenant),
      body: result(2),
    });
    expect(pastK.status).toBe(400);
    const stoppedButPassed = await call(`/runs/${runId}/results`, {
      token: await tokenFor(tenant),
      body: { ...result(1), graderOutput: { ...graderOutput(true), error: "Judge unreachable" } },
    });
    expect(stoppedButPassed.status).toBe(400);

    const reset = await call(`/runs/${runId}/reset`, {
      token: await tokenFor(tenant),
      hostToken: tenant.hostToken,
    });
    expect(Schemas.ZResetEvalRunApiResponse.parse(await reset.json()).isReset).toBe(true);
    expect((await readAlpha(tenant.hostToken))?.amount).toBe(120);

    const finished = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(tenant),
      body: { isComplete: true },
    });
    expect(finished.status).toBe(200);
    expect(Schemas.ZFinishEvalRunApiResponse.parse(await finished.json())).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Done,
      caseCount: started.cases.length,
      passAllKCount: started.cases.length,
      hasPassed: true,
    });
    const [done] = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(evalRuns).where(eq(evalRuns.publicId, runId)),
    );
    expect(done?.finishedAt).not.toBeNull();
    expect(Number(done?.costUsd)).toBeGreaterThan(0);

    // DEV_NOTE: A finished run takes nothing more
    const again = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(tenant),
      body: { isComplete: true },
    });
    expect(again.status).toBe(409);
    expect((await runAttempt(tenant, runId)).status).toBe(409);
  });

  it("refuses a Done finish while a case is missing attempts, and ends a stopped run Failed", async () => {
    const tenant = await createTenant();
    const started = await startRun(tenant, 2);
    const runId = started.run.publicId;
    await call(`/runs/${runId}/results`, {
      token: await tokenFor(tenant),
      body: {
        caseId: tenant.casePublicId,
        attempt: 1,
        hasPassed: false,
        graderOutput: graderOutput(false),
        latencyMs: null,
      },
    });

    const incomplete = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(tenant),
      body: { isComplete: true },
    });
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({
      failure: Schemas.EvalRunStepFailureEnum.Incomplete,
    });

    const stopped = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(tenant),
      body: { isComplete: false },
    });
    expect(Schemas.ZFinishEvalRunApiResponse.parse(await stopped.json())).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Failed,
      caseCount: started.cases.length,
      passAllKCount: 0,
      hasPassed: false,
    });
  });

  it("holds a run to the cases it started with, on the connection it started on", async () => {
    const tenant = await createTenant();
    const skipped = await addCase(tenant);
    const started = await startRun(tenant);
    const runId = started.run.publicId;
    expect(started.cases.map((evalCase) => evalCase.publicId)).toContain(skipped);

    // DEV_NOTE: Every case but one has its attempt: Done is refused, whatever the cases with results say
    await recordAll(tenant, started, [skipped]);
    const incomplete = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(tenant),
      body: { isComplete: true },
    });
    expect(incomplete.status).toBe(409);

    // DEV_NOTE: A case made after the start is not the run's (nor is one turned off since: the same check)
    const late = await addCase(tenant);
    const lateResult = await call(`/runs/${runId}/results`, {
      token: await tokenFor(tenant),
      body: {
        caseId: late,
        attempt: 1,
        hasPassed: true,
        graderOutput: graderOutput(true),
        latencyMs: null,
      },
    });
    expect(lateResult.status).toBe(404);

    // DEV_NOTE: Another staging connection of the same company can't drive or reset this run
    const otherStaging = await withOwnerDb(async (ownerDb) => {
      const [connection] = await ownerDb
        .insert(companyConnections)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: tenant.companyId,
          environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
          baseUrl: Schemas.getTestHostBaseUrl(testHostIssuer),
          jwtIssuer: `https://${crypto.randomUUID()}.staging.example.com`,
          authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
          authConfig: {},
          credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
          allowedOrigins: ["https://app.example.com"],
          resetOp: Schemas.TEST_HOST_RESET_OP,
        })
        .returning({ publicId: companyConnections.publicId });
      return connection?.publicId ?? "";
    });
    const asOtherConnection = await call(`/runs/${runId}/reset`, {
      token: await tokenFor(tenant, { connection: otherStaging }),
      hostToken: tenant.hostToken,
    });
    expect(asOtherConnection.status).toBe(404);

    await recordAll(
      tenant,
      started,
      started.cases.map((evalCase) => evalCase.publicId).filter((id) => id !== skipped),
    );
    const finished = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(tenant),
      body: { isComplete: true },
    });
    expect(Schemas.ZFinishEvalRunApiResponse.parse(await finished.json())).toMatchObject({
      status: Schemas.EvalRunStatusIntEnum.Done,
      caseCount: started.cases.length,
      passAllKCount: started.cases.length,
    });
  });

  it("never lets the widget resume an eval conversation", async () => {
    const tenant = await createTenant();
    const started = await startRun(tenant);
    const authenticated = await new EvalAuthRepo(evalEnv).authenticate(await tokenFor(tenant));
    if (!authenticated.isSuccess) throw new Error(authenticated.message);
    const [run] = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(evalRuns).where(eq(evalRuns.publicId, started.run.publicId)),
    );
    const conversationsRepo = new ConversationsRepo(env);
    const evalConversation = await conversationsRepo.startEvalConversation({
      identity: authenticated.identity,
      evalRunId: run?.id ?? "",
      chatbotConfigId: tenant.configId,
      chatbot: { id: tenant.chatbotId, publicId: tenant.chatbotPublicId, name: "Records bot" },
    });
    expect(evalConversation.isSuccess).toBe(true);

    // DEV_NOTE: The same host user, signed in to the staging host's widget, naming the eval conversation
    const resumed = await conversationsRepo.startOrResume({
      identity: {
        companyId: tenant.companyId,
        connectionId: authenticated.identity.connectionId,
        connectionEnvironment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        chatbotId: tenant.chatbotId,
        chatbotPublicId: tenant.chatbotPublicId,
        chatbotName: "Records bot",
        hostUserId: HOST_USER,
        displayName: null,
        roles: [],
        tokenExpiresAt: new Date(Date.now() + 60_000),
      },
      conversationPublicId: evalConversation.session?.conversationPublicId ?? "",
    });
    expect(resumed).toMatchObject({
      isSuccess: false,
      failure: Schemas.ConversationStartFailureEnum.NotFound,
    });
  });

  it("keeps each company's runs its own", async () => {
    const owner = await createTenant();
    const other = await createTenant();
    const started = await startRun(owner);
    const runId = started.run.publicId;

    const asOther = await call(`/runs/${runId}/finish`, {
      token: await tokenFor(other),
      body: { isComplete: false },
    });
    expect(asOther.status).toBe(404);
    const otherCase = await call(`/runs/${runId}/results`, {
      token: await tokenFor(owner),
      body: {
        caseId: other.casePublicId,
        attempt: 1,
        hasPassed: true,
        graderOutput: graderOutput(true),
        latencyMs: null,
      },
    });
    expect(otherCase.status).toBe(404);
    const otherConfig = await call("/runs", {
      token: await tokenFor(owner),
      body: {
        chatbotConfigId: other.configPublicId,
        k: 1,
        harnessVersion: "test-1",
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
      },
    });
    expect(otherConfig.status).toBe(404);
  });
});
