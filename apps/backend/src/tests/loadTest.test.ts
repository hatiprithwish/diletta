import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { streamText } from "ai";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  companies,
  companyConnections,
  companyEncryptionKeys,
  eventOutbox,
  modelCalls,
} from "@/db/tables";
import worker from "@/index";
import { BudgetDO } from "@/durable-objects/BudgetDO";
import AiGatewayProvider from "@/providers/aiGateway";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import Utility from "@/utils/Utility";
import { routeTestHostFetch, testHostIssuer } from "@/tests/helpers/testHost";
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

// DEV_NOTE: The load test's backend side (M6-5) against the Neon staging branch: /eval/load/* through the worker with a
// platform-signed eval JWT (a key generated per run), the real BudgetDO, and the company's rows as diletta_app. Each
// scenario gets its own company (so its own BudgetDO) with a staging connection, created like evalHarness.test.ts does.
// afterAll deletes every row it created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const HOST_USER = "load-test-user";
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
    company: { name: `Load test ${crypto.randomUUID()}` },
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
    const [staging] = await ownerDb
      .insert(companyConnections)
      .values({
        companyId,
        publicId: Utility.generatePublicId(),
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: Schemas.getTestHostBaseUrl(Schemas.TEST_HOST_STAGING_ISSUER),
        authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        allowedOrigins: ["https://app.example.com"],
        jwtIssuer: `https://${crypto.randomUUID()}.staging.example.com`,
      })
      .returning({ publicId: companyConnections.publicId });
    return { companyId, companyPublicId, stagingPublicId: staging?.publicId ?? "" };
  });
}

async function tokenFor(tenant: Tenant): Promise<string> {
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

// DEV_NOTE: loadCompany = the env's LOAD_TEST_COMPANY_ID for this request ("" = none)
async function call(
  tenant: Tenant,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; loadCompany?: string | null; token?: string | null } = {},
): Promise<Response> {
  const token = options.token === undefined ? await tokenFor(tenant) : options.token;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://localhost/eval/load${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    }),
    {
      ...evalEnv,
      LOAD_TEST_COMPANY_ID:
        options.loadCompany === undefined ? tenant.companyPublicId : (options.loadCompany ?? ""),
    } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function startWindow(tenant: Tenant) {
  const response = await call(tenant, "POST", "/window");
  expect(response.status).toBe(200);
  return Schemas.ZEvalLoadWindowApiResponse.parse(await response.json());
}

async function summary(tenant: Tenant, since: string) {
  const response = await call(tenant, "GET", `/summary?since=${encodeURIComponent(since)}`);
  expect(response.status).toBe(200);
  return Schemas.ZEvalLoadSummaryApiResponse.parse(await response.json());
}

async function reserve(tenant: Tenant, amountMicros: number) {
  const response = await call(tenant, "POST", "/reserve", { body: { amountMicros } });
  expect(response.status).toBe(200);
  return Schemas.ZEvalLoadReserveApiResponse.parse(await response.json());
}

async function release(tenant: Tenant, reservationId: string) {
  const response = await call(tenant, "POST", "/release", { body: { reservationId } });
  expect(response.status).toBe(200);
  return Schemas.ZEvalLoadReleaseApiResponse.parse(await response.json());
}

beforeAll(async () => {
  evalKey = await createKey(Schemas.WidgetJwtAlgorithmEnum.ES256, `load-${crypto.randomUUID()}`);
  evalEnv = { ...env, EVAL_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [evalKey.jwk] }) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
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

describe("/eval/load/* access", () => {
  it("answers 401 without a token, and 403 for a company that isn't the load test company", async () => {
    const tenant = await createTenant();

    const noToken = await call(tenant, "POST", "/window", { token: null });
    expect(noToken.status).toBe(401);

    // DEV_NOTE: A valid eval token for a real company with a staging connection is still refused when the env names
    // no load test company, or another one
    for (const loadCompany of [null, "", Utility.generatePublicId()]) {
      const calls = [
        await call(tenant, "POST", "/window", { loadCompany }),
        await call(
          tenant,
          "GET",
          `/summary?since=${encodeURIComponent(new Date().toISOString())}`,
          {
            loadCompany,
          },
        ),
        await call(tenant, "POST", "/reserve", { loadCompany, body: { amountMicros: 1 } }),
        await call(tenant, "POST", "/release", {
          loadCompany,
          body: { reservationId: crypto.randomUUID() },
        }),
      ];
      for (const response of calls) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          isSuccess: false,
          message: "Forbidden",
          failure: Schemas.EvalAuthFailureEnum.Forbidden,
        });
      }
    }
  });

  it("refuses a malformed body or query with 400", async () => {
    const tenant = await createTenant();
    expect((await call(tenant, "POST", "/reserve", { body: { amountMicros: 0 } })).status).toBe(
      400,
    );
    expect(
      (
        await call(tenant, "POST", "/reserve", {
          body: { amountMicros: Schemas.LOAD_CONTENTION_MAX_AMOUNT_MICROS + 1 },
        })
      ).status,
    ).toBe(400);
    expect((await call(tenant, "POST", "/release", { body: { reservationId: "x" } })).status).toBe(
      400,
    );
    expect((await call(tenant, "GET", "/summary?since=yesterday")).status).toBe(400);
  });
});

describe("Budget contention", () => {
  it("admits exactly what the budget has room for when many holds arrive at once, and gives it all back", async () => {
    const tenant = await createTenant();
    const window = await startWindow(tenant);
    expect(window.budget.budgetMicros).toBe(
      Schemas.usdToMicros(Schemas.DEFAULT_SPENDING_BUDGET_USD),
    );
    const headroom =
      window.budget.budgetMicros - window.budget.spentMicros - window.budget.heldMicros;
    const holdCount = 20;
    // DEV_NOTE: Room for exactly half of them
    const amountMicros = Math.floor(headroom / (holdCount / 2));
    const expectedAdmitted = Math.floor(headroom / amountMicros);

    const answers = await Promise.all(
      Array.from({ length: holdCount }, () => reserve(tenant, amountMicros)),
    );
    const admitted = answers.filter((answer) => answer.isAdmitted);
    const refused = answers.filter((answer) => !answer.isAdmitted);
    expect(admitted).toHaveLength(expectedAdmitted);
    expect(refused).toHaveLength(holdCount - expectedAdmitted);
    expect(
      refused.every((answer) => answer.refusal === Schemas.BudgetRefusalEnum.CompanyBudget),
    ).toBe(true);
    expect(admitted.every((answer) => answer.reservationId)).toBe(true);
    expect(answers.every((answer) => answer.serverMs >= 0)).toBe(true);

    const held = await summary(tenant, window.startedAt);
    expect(held.budget.openReservationCount).toBe(expectedAdmitted);
    expect(held.budget.heldMicros).toBe(expectedAdmitted * amountMicros);
    expect(held.budget.spentMicros).toBe(window.budget.spentMicros);

    await Promise.all(admitted.map((answer) => release(tenant, answer.reservationId ?? "")));
    const released = await summary(tenant, window.startedAt);
    expect(released.budget.openReservationCount).toBe(0);
    expect(released.budget.heldMicros).toBe(0);
    // DEV_NOTE: A release costs nothing: spend is where the window found it
    expect(released.budget.spentMicros).toBe(window.budget.spentMicros);

    // DEV_NOTE: The DO timed every call of the window (the hold, the refused ones and the releases)
    expect(released.timings.reserve.count).toBe(holdCount);
    expect(released.timings.settle.count).toBe(expectedAdmitted);
    expect(released.timings.admitTurn.count).toBe(0);
    expect(released.timingsSince).toBeGreaterThan(0);
  });

  it("starts a new window's timings over, and releasing a hold twice changes nothing", async () => {
    const tenant = await createTenant();
    const first = await startWindow(tenant);
    const held = await reserve(tenant, 1_000);
    expect(held.isAdmitted).toBe(true);
    expect((await summary(tenant, first.startedAt)).timings.reserve.count).toBe(1);

    await release(tenant, held.reservationId ?? "");
    await release(tenant, held.reservationId ?? "");
    const second = await startWindow(tenant);
    expect(second.budget.openReservationCount).toBe(0);
    expect(second.budget.spentMicros).toBe(first.budget.spentMicros);
    const fresh = await summary(tenant, second.startedAt);
    expect(fresh.timings.reserve.count).toBe(0);
    expect(fresh.timings.settle.count).toBe(0);
  });
});

describe("Load window stats", () => {
  it("sums the company's model calls and outbox lag since the window began, and leaves out older rows and embeddings", async () => {
    const tenant = await createTenant();
    const window = await startWindow(tenant);
    const since = new Date(window.startedAt);
    const before = new Date(since.getTime() - 60_000);
    const after = new Date(since.getTime() + 1_000);

    await withOwnerDb(async (ownerDb) => {
      const call = (overrides: Partial<typeof modelCalls.$inferInsert>) => ({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
        tier: Schemas.ModelCallTierIntEnum.Mid,
        provider: Schemas.ModelProviderEnum.Anthropic,
        model: "claude-sonnet-5-5",
        createdAt: after,
        updatedAt: after,
        ...overrides,
      });
      await ownerDb.insert(modelCalls).values([
        call({ costUsd: "0.250000" }),
        call({ costUsd: "0.000123" }),
        call({ costUsd: "0", usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending }),
        // DEV_NOTE: Not counted: before the window, and an embedding (the platform pays for it)
        call({ costUsd: "9.000000", createdAt: before, updatedAt: before }),
        call({ costUsd: "7.000000", tier: Schemas.ModelCallTierIntEnum.Embed }),
      ]);

      const logs = await ownerDb
        .insert(activityLog)
        .values(
          [0, 1, 2, 3].map(() => ({
            companyId: tenant.companyId,
            actorType: Schemas.ActivityLogActorTypeIntEnum.System,
            entityType: "conversation",
            entityAction: "started",
          })),
        )
        .returning({ id: activityLog.id });
      const outbox = (index: number, createdAt: Date, lagMs: number | null) => ({
        companyId: tenant.companyId,
        activityLogId: logs[index]?.id ?? "",
        eventType: "load.test",
        dedupeKey: `load-test:${tenant.companyId}:${index}`,
        createdAt,
        publishedAt: lagMs === null ? null : new Date(createdAt.getTime() + lagMs),
        status:
          lagMs === null
            ? Schemas.EventOutboxStatusIntEnum.Pending
            : Schemas.EventOutboxStatusIntEnum.Published,
      });
      await ownerDb.insert(eventOutbox).values([
        outbox(0, after, 100),
        outbox(1, after, 200),
        outbox(2, after, 900),
        // DEV_NOTE: Still waiting: counted as an event, not in the lag
        outbox(3, after, null),
      ]);
    });

    const result = await summary(tenant, window.startedAt);
    expect(result.modelCalls).toEqual({ callCount: 3, pendingCount: 1, costMicros: 250_123 });
    expect(result.outbox).toEqual({
      eventCount: 4,
      publishedCount: 3,
      unpublishedCount: 1,
      lagP50Ms: 200,
      lagP95Ms: 900,
      lagMaxMs: 900,
    });

    // DEV_NOTE: Another window start counts only what came after it
    const later = await summary(tenant, new Date(after.getTime() + 60_000).toISOString());
    expect(later.modelCalls).toEqual({ callCount: 0, pendingCount: 0, costMicros: 0 });
    expect(later.outbox.eventCount).toBe(0);
  });
});

describe("Load window stats across companies", () => {
  it("never count another company's model calls or outbox rows", async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    const window = await startWindow(tenant);
    const after = new Date(new Date(window.startedAt).getTime() + 1_000);

    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(modelCalls).values({
        publicId: Utility.generatePublicId(),
        companyId: other.companyId,
        taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
        tier: Schemas.ModelCallTierIntEnum.Mid,
        provider: Schemas.ModelProviderEnum.Anthropic,
        model: "claude-sonnet-5-5",
        costUsd: "3.000000",
        createdAt: after,
        updatedAt: after,
      });
      const [log] = await ownerDb
        .insert(activityLog)
        .values({
          companyId: other.companyId,
          actorType: Schemas.ActivityLogActorTypeIntEnum.System,
          entityType: "conversation",
          entityAction: "started",
        })
        .returning({ id: activityLog.id });
      await ownerDb.insert(eventOutbox).values({
        companyId: other.companyId,
        activityLogId: log?.id ?? "",
        eventType: "load.test",
        dedupeKey: `load-test:${other.companyId}:0`,
        createdAt: after,
        publishedAt: new Date(after.getTime() + 500),
        status: Schemas.EventOutboxStatusIntEnum.Published,
      });
    });

    const mine = await summary(tenant, window.startedAt);
    expect(mine.modelCalls).toEqual({ callCount: 0, pendingCount: 0, costMicros: 0 });
    expect(mine.outbox.eventCount).toBe(0);
    const theirs = await summary(other, window.startedAt);
    expect(theirs.modelCalls.callCount).toBe(1);
    expect(theirs.outbox.eventCount).toBe(1);
  });
});

describe("BudgetDO timings", () => {
  it("keeps the last samples of each operation, and a snapshot of a company that isn't its own is refused", async () => {
    const tenant = await createTenant();
    const stub = BudgetDO.forCompany(env, tenant.companyId);
    await stub.resetTimings();

    const held = await stub.reserve({
      companyId: tenant.companyId,
      chatbotUserId: null,
      userDailyCostCapUsd: null,
      amountMicros: 500,
    });
    expect(held.isSuccess).toBe(true);
    await stub.settle({
      companyId: tenant.companyId,
      reservationId: held.reservationId ?? "",
      costMicros: 200,
    });

    const timings = await stub.getTimings();
    expect(timings.timings?.reserve.count).toBe(1);
    expect(timings.timings?.settle.count).toBe(1);
    expect(timings.timings?.admitTurn.count).toBe(0);
    expect(timings.timingsSince).toBeLessThanOrEqual(Date.now());

    const snapshot = await stub.getSnapshot({ companyId: tenant.companyId });
    expect(snapshot.snapshot).toMatchObject({
      spentMicros: 200,
      heldMicros: 0,
      openReservationCount: 0,
    });

    const other = await stub.getSnapshot({ companyId: "999999999999" });
    expect(other.isSuccess).toBe(false);
    const invalid = await stub.getSnapshot({ companyId: "not-a-number" });
    expect(invalid.isSuccess).toBe(false);
  });
});

describe("Stub model key", () => {
  const stubKey = `${Schemas.LOAD_STUB_MODEL_KEY_PREFIX}${crypto.randomUUID()}`;
  // DEV_NOTE: The var is typed as the literals wrangler.jsonc holds, so a test value goes through a string parameter
  const envWithOverride = (override: string) =>
    ({ ...env, MODEL_BASE_URL_OVERRIDE: override }) as Env;
  const stubEnv = envWithOverride("https://stub.example.com/model-stub/anthropic/v1/");

  it("redirects only a stub key, and only when the env has an override", () => {
    expect(AiGatewayProvider.getStubBaseUrl(stubEnv, stubKey)).toBe(
      "https://stub.example.com/model-stub/anthropic/v1",
    );
    expect(AiGatewayProvider.getStubBaseUrl(stubEnv, "sk-ant-real-key")).toBeNull();
    expect(AiGatewayProvider.getStubBaseUrl(env, stubKey)).toBeNull();
    expect(AiGatewayProvider.getStubBaseUrl(envWithOverride("  "), stubKey)).toBeNull();
  });

  it("checks a stub key against the stub, with no gateway token, and a real key against the gateway", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
      });
      return new Response("{}", { status: 200 });
    });

    const checked = await AiGatewayProvider.checkModelKey(stubEnv, {
      provider: Schemas.ModelProviderEnum.Anthropic,
      apiKey: stubKey,
    });
    expect(checked).toBe(Schemas.ModelKeyCheckOutcomeEnum.Valid);
    expect(requests[0]?.url).toBe("https://stub.example.com/model-stub/anthropic/v1/models");
    expect(requests[0]?.headers.get("cf-aig-authorization")).toBeNull();

    await AiGatewayProvider.checkModelKey(
      { ...stubEnv, AI_GATEWAY_TOKEN: "test-gateway-token" } as Env,
      { provider: Schemas.ModelProviderEnum.Anthropic, apiKey: "sk-ant-real-key" },
    );
    expect(requests[1]?.url).toContain("gateway.ai.cloudflare.com");
    expect(requests[1]?.headers.get("cf-aig-authorization")).toBe("Bearer test-gateway-token");
  });

  it("builds a stub key's model with no gateway token, and a real key's model needs one", async () => {
    const middleware = {} as Parameters<typeof AiGatewayProvider.createModel>[1]["middleware"];
    const params = {
      provider: Schemas.ModelProviderEnum.Anthropic,
      model: "claude-sonnet-5-5",
      metadata: {},
      middleware,
    };
    const withoutGatewayToken = { ...stubEnv, AI_GATEWAY_TOKEN: "" } as Env;

    const stub = await AiGatewayProvider.createModel(withoutGatewayToken, {
      ...params,
      apiKey: stubKey,
    });
    expect(stub.isSuccess).toBe(true);

    const real = await AiGatewayProvider.createModel(withoutGatewayToken, {
      ...params,
      apiKey: "sk-ant-real-key",
    });
    expect(real.isSuccess).toBe(false);
  });
});

describe("A chat's model call through the stub", () => {
  it("runs the router, the budget and the recording on the stub model, and the ledger and model_calls agree on the cost", async () => {
    const tenant = await createTenant();
    const stubKey = `${Schemas.LOAD_STUB_MODEL_KEY_PREFIX}${crypto.randomUUID()}`;
    const created = await new CompanySecretsRepo(env).createCompanySecret({
      companyId: tenant.companyId,
      connectionId: null,
      companySecret: {
        type: Schemas.CompanySecretTypeIntEnum.ModelKey,
        provider: Schemas.ModelProviderEnum.Anthropic,
        secret: stubKey,
        expiresAt: null,
      },
    });
    expect(created.companySecret).toBeDefined();

    // DEV_NOTE: The stub is the test host's, reached in-process; the gateway is never called (no fetch to it is mocked)
    routeTestHostFetch();
    const stubEnv = {
      ...env,
      MODEL_BASE_URL_OVERRIDE: `${testHostIssuer}${Schemas.TEST_HOST_MODEL_STUB_PATH}`,
    } as Env;
    const pending: Promise<unknown>[] = [];
    const router = new ModelRouterRepo(stubEnv, {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    });
    const window = await startWindow(tenant);

    const routed = await router.getModel({
      companyId: tenant.companyId,
      chatbotId: null,
      chatbotUserId: null,
      conversationId: null,
      evalRunId: null,
      turnId: Utility.generateUlid(),
      taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
      tier: null,
      routing: {
        small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
        mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
        top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
        defaultTier: Schemas.ModelTierEnum.Mid,
      },
      caps: null,
    });
    if (!routed.isSuccess) throw new Error(`No model: ${routed.message}`);
    const result = streamText({ model: routed.model, prompt: "Hello" });
    expect(await result.text).toBe(Schemas.TEST_HOST_MODEL_STUB_REPLY);
    while (pending.length > 0) await Promise.all(pending.splice(0));

    const price = Schemas.getModelPrice(Schemas.ModelProviderEnum.Anthropic, "claude-sonnet-5-5");
    if (!price) throw new Error("No price");
    const costMicros = Schemas.usdToMicros(
      Schemas.computeModelCallCostUsd(price, {
        inputTokens: Schemas.TEST_HOST_MODEL_STUB_INPUT_TOKENS,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: Schemas.TEST_HOST_MODEL_STUB_OUTPUT_TOKENS,
      }),
    );
    const after = await summary(tenant, window.startedAt);
    expect(after.modelCalls).toEqual({ callCount: 1, pendingCount: 0, costMicros });
    expect(after.budget.spentMicros - window.budget.spentMicros).toBe(costMicros);
    expect(after.budget.openReservationCount).toBe(0);
    expect(after.timings.reserve.count).toBe(1);
    expect(after.timings.settle.count).toBe(1);
  });
});
