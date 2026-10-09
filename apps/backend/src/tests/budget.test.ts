import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { generateText } from "ai";
import * as Schemas from "@app/schemas";
import {
  chatbotUsers,
  chatbots,
  companies,
  companyEncryptionKeys,
  companySecrets,
  conversations,
  modelCalls,
} from "@/db/tables";
import TurnBudgetProvider from "@/providers/turnBudget";
import BudgetRepo from "@/repositories/BudgetRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import Utility from "@/utils/Utility";
import {
  anthropicMessage,
  gatewayRequests,
  mockCloudflare,
  mockedRequests,
} from "@/tests/helpers/gateway";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Budget (M2-4) against the Neon staging branch. Each scenario gets its own company (so its own BudgetDO),
// created through CompaniesRepo, with a chatbot, a chatbot user and a conversation as owner fixtures; spending_budget
// and seed model_calls rows are set as owner. BudgetDO and the router run as diletta_app (HYPERDRIVE), so RLS applies
// to the seed. AI Gateway is never reached: fetch is replaced for the gateway host only and records each request, so a
// test can prove a refused call never went out. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];
const routerEnv = (): Env => ({ ...env, AI_GATEWAY_TOKEN: "test-gateway-token" });
const LEDGER_KEY = "ledger";

let ownerPool: Pool | null = null;

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

function createCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    settle: async () => {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0));
      }
    },
  };
}

// DEV_NOTE: spendingBudget undefined leaves the column NULL (the platform default applies)
async function createFixture(spendingBudget?: string) {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Budget test company ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const publicId = created.company.publicId;

  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, publicId));
    const companyId = company?.id ?? "";
    createdCompanyIds.push(companyId);
    if (spendingBudget !== undefined) {
      await ownerDb.update(companies).set({ spendingBudget }).where(eq(companies.id, companyId));
    }

    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId, name: "Budget test bot" })
      .returning({ id: chatbots.id });
    const [chatbotUser] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId, hostUserId: `host-${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    const [conversation] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        chatbotId: chatbot?.id ?? "",
        chatbotUserId: chatbotUser?.id ?? "",
      })
      .returning({ id: conversations.id });

    return {
      companyId,
      chatbotId: chatbot?.id ?? "",
      chatbotUserId: chatbotUser?.id ?? "",
      conversationId: conversation?.id ?? "",
    };
  });
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function addAnthropicKey(companyId: string): Promise<void> {
  const created = await new CompanySecretsRepo(env).createCompanySecret({
    companyId,
    connectionId: null,
    companySecret: {
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider: Schemas.ModelProviderEnum.Anthropic,
      secret: `sk-ant-${crypto.randomUUID()}`,
      expiresAt: null,
    },
  });
  if (!created.companySecret) throw new Error(`Model key not created: ${created.message}`);
}

async function insertSpend(companyId: string, costUsd: string, createdAt: Date): Promise<void> {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.insert(modelCalls).values({
      publicId: Utility.generatePublicId(),
      companyId,
      taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
      tier: Schemas.ModelCallTierIntEnum.Mid,
      provider: Schemas.ModelProviderEnum.Anthropic,
      model: "claude-sonnet-5-5",
      costUsd,
      createdAt,
      updatedAt: createdAt,
    });
  });
}

const routing: Schemas.ConfigSpec["routing"] = {
  small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
  mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
  top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
  defaultTier: Schemas.ModelTierEnum.Mid,
};

function request(
  fixture: Fixture,
  caps: Schemas.ModelCallCaps | null = null,
): Schemas.GetModelRequest {
  return {
    companyId: fixture.companyId,
    chatbotId: fixture.chatbotId,
    chatbotUserId: fixture.chatbotUserId,
    conversationId: fixture.conversationId,
    evalRunId: null,
    turnId: Utility.generateUlid(),
    taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
    tier: null,
    routing,
    caps,
  };
}

async function routeOrThrow(router: ModelRouterRepo, params: Schemas.GetModelRequest) {
  const routed = await router.getModel(params);
  if (!routed.isSuccess) throw new Error(`No model: ${routed.message}`);
  return routed.model;
}

const budgetDo = (companyId: string) => env.BUDGET_DO.getByName(companyId);

async function readLedger(companyId: string): Promise<Schemas.BudgetLedger> {
  return await runInDurableObject(budgetDo(companyId), (_instance, state) =>
    Schemas.ZBudgetLedger.parse(state.storage.kv.get(LEDGER_KEY)),
  );
}

async function patchLedger(companyId: string, patch: Partial<Schemas.BudgetLedger>) {
  await runInDurableObject(budgetDo(companyId), (_instance, state) => {
    const ledger = Schemas.ZBudgetLedger.parse(state.storage.kv.get(LEDGER_KEY));
    state.storage.kv.put(LEDGER_KEY, { ...ledger, ...patch });
  });
}

async function reservationCount(companyId: string): Promise<number> {
  return await runInDurableObject(
    budgetDo(companyId),
    (_instance, state) => [...state.storage.kv.list({ prefix: "reservation:" })].length,
  );
}

const reserve = (
  fixture: Fixture,
  amountMicros: number,
  userDailyCostCapUsd: number | null = null,
) =>
  budgetDo(fixture.companyId).reserve({
    companyId: fixture.companyId,
    chatbotUserId: userDailyCostCapUsd === null ? null : fixture.chatbotUserId,
    userDailyCostCapUsd,
    amountMicros,
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
      await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
      await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
      await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
      await ownerDb
        .delete(companyEncryptionKeys)
        .where(inArray(companyEncryptionKeys.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

describe("Budget on the model router", () => {
  it("refuses an over-budget call before it reaches the provider", async () => {
    const fixture = await createFixture("0.000001");
    await addAnthropicKey(fixture.companyId);
    mockCloudflare((mocked) => anthropicMessage(String(mocked.body?.model)));
    const { ctx, settle } = createCtx();
    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture));

    await expect(generateText({ model, prompt: "Hi" })).rejects.toMatchObject({
      name: "ModelUnavailableError",
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    await settle();

    expect(gatewayRequests()).toHaveLength(0);
    const rows = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(modelCalls).where(eq(modelCalls.companyId, fixture.companyId)),
    );
    expect(rows).toHaveLength(0);
    expect(await reservationCount(fixture.companyId)).toBe(0);
  });

  it("settles a call's hold with its real cost, the same as its model_calls row", async () => {
    const fixture = await createFixture("5");
    await addAnthropicKey(fixture.companyId);
    mockCloudflare((mocked) => anthropicMessage(String(mocked.body?.model)));
    const { ctx, settle } = createCtx();
    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture));

    await generateText({ model, prompt: "Hi" });
    await settle();

    const [row] = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(modelCalls).where(eq(modelCalls.companyId, fixture.companyId)),
    );
    const ledger = await readLedger(fixture.companyId);
    expect(row?.costUsd).toBeDefined();
    expect(ledger.spentMicros).toBe(Schemas.usdToMicros(row?.costUsd ?? "0"));
    expect(ledger.spentMicros).toBeGreaterThan(0);
    expect(ledger.budgetMicros).toBe(5_000_000);
    expect(await reservationCount(fixture.companyId)).toBe(0);
    // DEV_NOTE: The request asked for no more than the platform output cap
    expect(gatewayRequests()[0]?.body?.max_tokens).toBe(8_192);
  });

  it("stops a call at the conversation's cost cap before BudgetDO or the provider", async () => {
    const fixture = await createFixture("5");
    await addAnthropicKey(fixture.companyId);
    mockCloudflare((mocked) => anthropicMessage(String(mocked.body?.model)));
    const caps = new TurnBudgetProvider({
      limits: { ...Schemas.CONFIG_SPEC_PLATFORM_DEFAULTS.limits, conversationCostCapUsd: 0.01 },
      getConversationSpentMicros: () => 9_999,
      onSpent: () => {},
    });
    const { ctx, settle } = createCtx();
    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture, caps));

    await expect(generateText({ model, prompt: "Hi" })).rejects.toMatchObject({
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    await settle();
    expect(gatewayRequests()).toHaveLength(0);
  });

  it("releases the caller's hold when BudgetDO refuses", async () => {
    const fixture = await createFixture("0.000001");
    await addAnthropicKey(fixture.companyId);
    mockCloudflare((mocked) => anthropicMessage(String(mocked.body?.model)));
    const caps = new TurnBudgetProvider({
      limits: Schemas.CONFIG_SPEC_PLATFORM_DEFAULTS.limits,
      getConversationSpentMicros: () => 0,
      onSpent: () => {},
    });
    const tokensBefore = caps.maxOutputTokens(0);
    const { ctx } = createCtx();
    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture, caps));

    await expect(generateText({ model, prompt: "Hi" })).rejects.toMatchObject({
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    expect(caps.maxOutputTokens(0)).toBe(tokensBefore);
    expect(caps.isExhausted()).toBe(false);
  });
});

describe("BudgetDO", () => {
  it("seeds the period from this company's model_calls since the 1st, as diletta_app", async () => {
    const fixture = await createFixture("1");
    const other = await createFixture("1");
    const periodStart = Schemas.budgetPeriodStart(Schemas.budgetPeriodKey(Date.now()));
    await insertSpend(fixture.companyId, "0.700000", new Date());
    await insertSpend(fixture.companyId, "5.000000", new Date(periodStart.getTime() - 60_000));
    await insertSpend(other.companyId, "5.000000", new Date());

    const fits = await reserve(fixture, 300_000);
    expect(fits.isSuccess).toBe(true);
    expect((await readLedger(fixture.companyId)).spentMicros).toBe(700_000);

    const over = await reserve(fixture, 1);
    expect(over).toMatchObject({
      isSuccess: false,
      refusal: Schemas.BudgetRefusalEnum.CompanyBudget,
    });
  });

  it("applies the $10 platform default when the company has no budget set", async () => {
    const fixture = await createFixture();
    expect(await reserve(fixture, 10_000_001)).toMatchObject({
      refusal: Schemas.BudgetRefusalEnum.CompanyBudget,
    });
    expect((await reserve(fixture, 10_000_000)).isSuccess).toBe(true);
  });

  it("keeps a call of unknown cost counted at its whole hold, and settles once", async () => {
    const fixture = await createFixture("1");
    const held = await reserve(fixture, 200_000);
    if (!held.reservationId) throw new Error("Not reserved");

    const settle = () =>
      budgetDo(fixture.companyId).settle({
        companyId: fixture.companyId,
        reservationId: held.reservationId ?? "",
        costMicros: null,
      });
    expect((await settle()).isSuccess).toBe(true);
    expect((await settle()).isSuccess).toBe(true);

    const ledger = await readLedger(fixture.companyId);
    expect(ledger.spentMicros).toBe(200_000);
    expect(await reservationCount(fixture.companyId)).toBe(0);
  });

  it("counts a hold that was never settled as spent once it expires", async () => {
    const fixture = await createFixture("1");
    const held = await reserve(fixture, 400_000);
    await runInDurableObject(budgetDo(fixture.companyId), (_instance, state) => {
      const key = `reservation:${held.reservationId ?? ""}`;
      const stored = Schemas.ZBudgetReservation.parse(state.storage.kv.get(key));
      state.storage.kv.put(key, { ...stored, createdAt: Date.now() - 21 * 60_000 });
    });

    expect((await reserve(fixture, 1)).isSuccess).toBe(true);
    expect((await readLedger(fixture.companyId)).spentMicros).toBe(400_000);
    expect(await reservationCount(fixture.companyId)).toBe(1);
  });

  it("holds the user to their daily cap and message rate", async () => {
    const fixture = await createFixture("5");
    const admit = () =>
      budgetDo(fixture.companyId).admitTurn({
        companyId: fixture.companyId,
        chatbotUserId: fixture.chatbotUserId,
        userMessagesPerMinute: 2,
        userDailyCostCapUsd: 0.5,
      });

    expect((await admit()).isSuccess).toBe(true);
    expect((await admit()).isSuccess).toBe(true);
    expect(await admit()).toMatchObject({ refusal: Schemas.BudgetRefusalEnum.UserMessageRate });

    expect((await reserve(fixture, 500_000, 0.5)).isSuccess).toBe(true);
    expect(await reserve(fixture, 1, 0.5)).toMatchObject({
      refusal: Schemas.BudgetRefusalEnum.UserDailyCost,
    });
    // DEV_NOTE: A call without a chatbot user (an eval) isn't held to anyone's daily cap
    expect((await reserve(fixture, 1)).isSuccess).toBe(true);
  });

  it("picks up a changed budget at its next refresh", async () => {
    const fixture = await createFixture("1");
    expect((await reserve(fixture, 1)).isSuccess).toBe(true);
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(companies)
        .set({ spendingBudget: "3" })
        .where(eq(companies.id, fixture.companyId)),
    );

    // DEV_NOTE: Still the cached budget until the refresh is due
    expect(await reserve(fixture, 2_000_000)).toMatchObject({
      refusal: Schemas.BudgetRefusalEnum.CompanyBudget,
    });
    await patchLedger(fixture.companyId, { budgetLoadedAt: 0 });
    expect((await reserve(fixture, 2_000_000)).isSuccess).toBe(true);
    expect((await readLedger(fixture.companyId)).budgetMicros).toBe(3_000_000);
  });

  it("rolls over to a new period seeded from model_calls, dropping the old spend", async () => {
    const fixture = await createFixture("1");
    await insertSpend(fixture.companyId, "0.250000", new Date());
    expect((await reserve(fixture, 1)).isSuccess).toBe(true);
    await patchLedger(fixture.companyId, { periodKey: "2000-01", spentMicros: 999_999 });
    await runInDurableObject(budgetDo(fixture.companyId), (_instance, state) => {
      state.storage.kv.put("user:stale", {
        dayKey: "2000-01-31",
        spentMicros: 5,
        messageTimes: [],
      });
    });

    expect((await reserve(fixture, 1)).isSuccess).toBe(true);
    const ledger = await readLedger(fixture.companyId);
    expect(ledger.periodKey).toBe(Schemas.budgetPeriodKey(Date.now()));
    expect(ledger.spentMicros).toBe(250_000);
    // DEV_NOTE: Counters from an earlier day don't outlive the rollover
    const staleUser = await runInDurableObject(budgetDo(fixture.companyId), (_instance, state) =>
      state.storage.kv.get("user:stale"),
    );
    expect(staleUser).toBeUndefined();
  });

  it("refuses a request for another company (fail closed)", async () => {
    const fixture = await createFixture("1");
    const other = await createFixture("1");
    expect((await reserve(fixture, 1)).isSuccess).toBe(true);

    const crossed = await budgetDo(fixture.companyId).reserve({
      companyId: other.companyId,
      chatbotUserId: null,
      userDailyCostCapUsd: null,
      amountMicros: 1,
    });
    expect(crossed).toMatchObject({ refusal: Schemas.BudgetRefusalEnum.Unavailable });
  });
});

describe("BudgetRepo tenancy (as diletta_app)", () => {
  it("reads one company's budget and spend, never another's", async () => {
    const fixture = await createFixture("2.5");
    const other = await createFixture("9");
    await insertSpend(fixture.companyId, "0.100000", new Date());
    await insertSpend(other.companyId, "4.000000", new Date());

    const seed = await new BudgetRepo(env).getBudgetSeed({
      companyId: fixture.companyId,
      periodStart: Schemas.budgetPeriodStart(Schemas.budgetPeriodKey(Date.now())),
      isSpendNeeded: true,
    });
    expect(seed).toMatchObject({
      isSuccess: true,
      spendingBudgetUsd: "2.500000",
      spentUsd: "0.100000",
    });
  });

  it("fails for a company that doesn't exist", async () => {
    const seed = await new BudgetRepo(env).getBudgetSeed({
      companyId: "999999999999",
      periodStart: new Date(),
      isSpendNeeded: false,
    });
    expect(seed.isSuccess).toBe(false);
  });
});
