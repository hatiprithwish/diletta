import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { APICallError, generateText, streamText } from "ai";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import getDbClient from "@/db/dbClient";
import {
  activityLog,
  chatbotUsers,
  chatbots,
  companies,
  companyEncryptionKeys,
  companySecrets,
  conversations,
  eventOutbox,
  modelCalls,
  qualityIssues,
} from "@/db/tables";
import withTenant from "@/db/withTenant";
import AiGatewayProvider from "@/providers/aiGateway";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import ModelCallsRepo from "@/repositories/ModelCallsRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import Utility from "@/utils/Utility";
import {
  anthropicBrokenStream,
  anthropicMessage,
  anthropicStream,
  gatewayRequests,
  mockCloudflare,
  mockedRequests,
} from "@/tests/helpers/gateway";
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

// DEV_NOTE: Tests hit the Neon staging branch with the real staging master key. Each scenario gets its own company
// (created through CompaniesRepo, so it has a company key) with a chatbot, a chatbot user and a conversation inserted
// as owner fixtures (the conversations DAL comes with M2-2), and its model keys created through CompanySecretsRepo.
// The router and the backfill run as diletta_app (HYPERDRIVE), so RLS applies. AI Gateway and the Cloudflare API are
// never reached: fetch is replaced for those two hosts only, and records each request so the tests can check the
// URL, headers and body. EVENTS_QUEUE is a recording fake. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];
const GATEWAY_TOKEN = "test-gateway-token";
const GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}`;
const LOGS_URL = `https://api.cloudflare.com/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_NAME}/logs`;

class RecordingQueue implements Queue<Schemas.EventOutboxMessage> {
  sent: Schemas.EventOutboxMessage[] = [];

  async metrics(): Promise<QueueMetrics> {
    return { backlogCount: 0, backlogBytes: 0 };
  }

  async send(message: Schemas.EventOutboxMessage): Promise<QueueSendResponse> {
    this.sent.push(message);
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<Schemas.EventOutboxMessage>>,
  ): Promise<QueueSendBatchResponse> {
    this.sent.push(...[...messages].map((message) => message.body));
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  }
}

const queue = new RecordingQueue();
const routerEnv = (): Env => ({ ...env, AI_GATEWAY_TOKEN: GATEWAY_TOKEN, EVENTS_QUEUE: queue });

// DEV_NOTE: Collects what the router hands to waitUntil (model_calls rows, outbox relay), so a test can await them
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

let ownerPool: Pool | null = null;

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

async function createFixture() {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Test company ${crypto.randomUUID()}` },
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

    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId, name: "Router test bot" })
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

async function addModelKey(
  companyId: string,
  provider: Schemas.ModelProviderEnum,
  secret = `key-${crypto.randomUUID()}`,
): Promise<string> {
  const created = await new CompanySecretsRepo(env).createCompanySecret({
    companyId,
    connectionId: null,
    companySecret: {
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider,
      secret,
      expiresAt: null,
    },
  });
  if (!created.companySecret) throw new Error(`Model key not created: ${created.message}`);
  return created.companySecret.publicId;
}

const anthropicRouting: Schemas.ConfigSpec["routing"] = {
  small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
  mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
  top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
  defaultTier: Schemas.ModelTierEnum.Mid,
};

// DEV_NOTE: One tier per provider, to route through each
const mixedRouting: Schemas.ConfigSpec["routing"] = {
  small: { provider: Schemas.ModelProviderEnum.Google, model: "gemini-3.8-flash" },
  mid: { provider: Schemas.ModelProviderEnum.OpenAI, model: "gpt-6-sol" },
  top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
  defaultTier: Schemas.ModelTierEnum.Mid,
};

function request(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<Schemas.GetModelRequest> = {},
): Schemas.GetModelRequest {
  return {
    companyId: fixture.companyId,
    chatbotId: fixture.chatbotId,
    chatbotUserId: fixture.chatbotUserId,
    conversationId: fixture.conversationId,
    evalRunId: null,
    turnId: `01J${crypto.randomUUID().replace(/-/g, "").slice(0, 23).toUpperCase()}`,
    taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
    tier: null,
    routing: anthropicRouting,
    ...overrides,
  };
}

async function routeOrThrow(
  router: ModelRouterRepo,
  params: Schemas.GetModelRequest,
): Promise<Parameters<typeof generateText>[0]["model"]> {
  const routed = await router.getModel(params);
  if (!routed.isSuccess) throw new Error(`No model: ${routed.message}`);
  return routed.model;
}

const openAiResponse = (model: string) =>
  Response.json(
    {
      id: "resp_test",
      object: "response",
      created_at: 1_760_000_000,
      status: "completed",
      model,
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from OpenAI", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 1100,
      },
    },
    { headers: { "cf-aig-log-id": "log-openai" } },
  );

const googleResponse = () =>
  Response.json(
    {
      candidates: [
        {
          content: { parts: [{ text: "Hello from Gemini" }], role: "model" },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 },
      modelVersion: "gemini-3.8-flash",
    },
    { headers: { "cf-aig-log-id": "log-google" } },
  );

const anthropicError = (status: number, type: string) =>
  Response.json({ type: "error", error: { type, message: "provider said no" } }, { status });

const openAiKeyRejected = () =>
  Response.json(
    {
      error: {
        message: "Incorrect API key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    },
    { status: 401 },
  );

// DEV_NOTE: What the gateway itself answers when cf-aig-authorization is wrong: `error` is an array
const gatewayUnauthorized = () =>
  Response.json(
    { success: false, result: [], messages: [], error: [{ code: 2009, message: "Unauthorized" }] },
    { status: 401 },
  );

async function getModelCalls(companyId: string) {
  return await withOwnerDb(
    async (ownerDb) =>
      await ownerDb.select().from(modelCalls).where(eq(modelCalls.companyId, companyId)),
  );
}

async function getQualityIssues(companyId: string) {
  return await withOwnerDb(
    async (ownerDb) =>
      await ownerDb.select().from(qualityIssues).where(eq(qualityIssues.companyId, companyId)),
  );
}

async function getSecretStatus(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ status: companySecrets.status })
      .from(companySecrets)
      .where(eq(companySecrets.publicId, publicId));
    return row?.status;
  });
}

beforeAll(() => {
  expect(env.AI_GATEWAY_ACCOUNT_ID).toBeTruthy();
  expect(env.AI_GATEWAY_NAME).toBeTruthy();
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
      await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
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

describe("ModelRouterRepo.getModel", () => {
  it("routes the default tier through AI Gateway on the company's key and records the call", async () => {
    const fixture = await createFixture();
    const apiKey = `sk-ant-${crypto.randomUUID()}`;
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic, apiKey);
    mockCloudflare((mocked) => anthropicMessage(String(mocked.body?.model)));
    const { ctx, settle } = createCtx();
    const params = request(fixture);

    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), params);
    const result = await generateText({ model, prompt: "Hi" });
    expect(result.text).toBe("Hello from the gateway");
    await settle();

    expect(gatewayRequests()).toHaveLength(1);
    const [sent] = gatewayRequests();
    expect(sent?.url).toBe(`${GATEWAY_URL}/anthropic/v1/messages`);
    expect(sent?.body?.model).toBe("claude-sonnet-5-5");
    expect(sent?.headers.get("x-api-key")).toBe(apiKey);
    expect(sent?.headers.get("cf-aig-authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(JSON.parse(sent?.headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      companyId: fixture.companyId,
      chatbotId: fixture.chatbotId,
      conversationId: fixture.conversationId,
      turnId: params.turnId,
      taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
    });

    const [call] = await getModelCalls(fixture.companyId);
    expect(call).toMatchObject({
      chatbotId: fixture.chatbotId,
      chatbotUserId: fixture.chatbotUserId,
      conversationId: fixture.conversationId,
      turnId: params.turnId,
      taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
      tier: Schemas.ModelCallTierIntEnum.Mid,
      provider: Schemas.ModelProviderEnum.Anthropic,
      model: "claude-sonnet-5-5",
      gatewayLogId: "log-generate",
      // DEV_NOTE: Anthropic's input_tokens excludes cache reads; the total adds them back
      inputTokens: 1500,
      outputTokens: 200,
      cachedTokens: 500,
      wasEscalated: false,
      errorCode: null,
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
    });
    // 1000 uncached × $2 + 500 cache reads × $0.1 + 200 output × $10, per 1M tokens
    expect(call?.costUsd).toBe("0.004050");
    expect(call?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps an explicit tier to its model and records a streamed call once the stream ends", async () => {
    const fixture = await createFixture();
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare((mocked) => anthropicStream(String(mocked.body?.model)));
    const { ctx, settle } = createCtx();

    const model = await routeOrThrow(
      new ModelRouterRepo(routerEnv(), ctx),
      request(fixture, { tier: Schemas.ModelTierEnum.Small }),
    );
    const result = streamText({ model, prompt: "Hi" });
    expect(await result.text).toBe("Streamed");
    await settle();

    expect(gatewayRequests()[0]?.body?.model).toBe("claude-haiku-4-5");
    const [call] = await getModelCalls(fixture.companyId);
    expect(call).toMatchObject({
      tier: Schemas.ModelCallTierIntEnum.Small,
      model: "claude-haiku-4-5",
      gatewayLogId: "log-stream",
      inputTokens: 800,
      outputTokens: 50,
      errorCode: null,
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
    });
    // 800 input × $1 + 50 output × $5, per 1M tokens
    expect(call?.costUsd).toBe("0.001050");
  });

  it("routes OpenAI and Google tiers to their gateway endpoints with their own key headers", async () => {
    const fixture = await createFixture();
    const openAiKey = `sk-${crypto.randomUUID()}`;
    const googleKey = `AIza${crypto.randomUUID()}`;
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.OpenAI, openAiKey);
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Google, googleKey);
    mockCloudflare((mocked) =>
      mocked.url.includes("/openai/")
        ? openAiResponse(String(mocked.body?.model))
        : googleResponse(),
    );
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    const openAi = await generateText({
      model: await routeOrThrow(router, request(fixture, { routing: mixedRouting })),
      prompt: "Hi",
    });
    const google = await generateText({
      model: await routeOrThrow(
        router,
        request(fixture, { routing: mixedRouting, tier: Schemas.ModelTierEnum.Small }),
      ),
      prompt: "Hi",
    });
    await settle();

    expect(openAi.text).toBe("Hello from OpenAI");
    expect(google.text).toBe("Hello from Gemini");
    const [openAiRequest, googleRequest] = gatewayRequests();
    expect(openAiRequest?.url).toBe(`${GATEWAY_URL}/openai/responses`);
    expect(openAiRequest?.headers.get("authorization")).toBe(`Bearer ${openAiKey}`);
    expect(googleRequest?.url).toBe(
      `${GATEWAY_URL}/google-ai-studio/v1beta/models/gemini-3.8-flash:generateContent`,
    );
    expect(googleRequest?.headers.get("x-goog-api-key")).toBe(googleKey);
    for (const sent of [openAiRequest, googleRequest]) {
      expect(sent?.headers.get("cf-aig-authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
    }

    const calls = await getModelCalls(fixture.companyId);
    const byProvider = new Map(calls.map((call) => [call.provider, call]));
    // 1000 input × $2 + 100 output × $10 (gpt-6-sol); 1000 × $1.5 + 100 × $7.5 (gemini-3.8-flash), per 1M
    expect(byProvider.get(Schemas.ModelProviderEnum.OpenAI)).toMatchObject({
      model: "gpt-6-sol",
      tier: Schemas.ModelCallTierIntEnum.Mid,
      costUsd: "0.003000",
      gatewayLogId: "log-openai",
    });
    expect(byProvider.get(Schemas.ModelProviderEnum.Google)).toMatchObject({
      model: "gemini-3.8-flash",
      tier: Schemas.ModelCallTierIntEnum.Small,
      costUsd: "0.002250",
      gatewayLogId: "log-google",
    });
  });

  it("refuses a model missing from the price table before any key read or gateway call", async () => {
    const fixture = await createFixture();
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare(() => anthropicMessage("unused"));
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(
      request(fixture, {
        routing: {
          ...anthropicRouting,
          mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-unlisted" },
        },
      }),
    );
    await settle();

    expect(routed.isSuccess).toBe(false);
    expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.ModelNotPriced);
    expect(routed.model).toBeUndefined();
    expect(gatewayRequests()).toHaveLength(0);
    expect(await getModelCalls(fixture.companyId)).toHaveLength(0);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
  });

  it("answers ServerError without a gateway token, and opens no issue", async () => {
    const fixture = await createFixture();
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(
      { ...routerEnv(), AI_GATEWAY_TOKEN: "" },
      ctx,
    ).getModel(request(fixture));
    await settle();

    expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.ServerError);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
  });
});

describe("ModelRouterRepo usage recording", () => {
  it("records a stream cut mid-way as Pending with its error, never as a clean $0 call", async () => {
    const fixture = await createFixture();
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare((mocked) => anthropicBrokenStream(String(mocked.body?.model), "error"));
    const { ctx, settle } = createCtx();

    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture));
    const result = streamText({ model, prompt: "Hi", onError: () => {} });
    await result.consumeStream();
    await settle();

    const [call] = await getModelCalls(fixture.companyId);
    expect(call?.usageStatus).toBe(Schemas.ModelCallUsageStatusIntEnum.Pending);
    expect(call?.gatewayLogId).toBe("log-stream");
    expect(call?.errorCode).not.toBeNull();
    expect(call?.outputTokens).toBeNull();
  });

  it("records a stream the caller cancels as Pending and aborted", async () => {
    const fixture = await createFixture();
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare((mocked) =>
      anthropicBrokenStream(String(mocked.body?.model), "hang", mocked.signal),
    );
    const { ctx, settle } = createCtx();
    const abort = new AbortController();

    const model = await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture));
    const result = streamText({
      model,
      prompt: "Hi",
      abortSignal: abort.signal,
      onError: () => {},
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        abort.abort();
      }
    }
    await settle();

    const [call] = await getModelCalls(fixture.companyId);
    expect(call?.usageStatus).toBe(Schemas.ModelCallUsageStatusIntEnum.Pending);
    expect(call?.errorCode).toBe("aborted");
  });

  it("records a call that never got an answer as Unknown, and one the provider refused as Reported at 0", async () => {
    const fixture = await createFixture();
    await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    let answer: "drop" | "overloaded" = "drop";
    mockCloudflare(() => {
      if (answer === "drop") throw new TypeError("Network connection lost");
      return anthropicError(529, "overloaded_error");
    });
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    await expect(
      generateText({
        model: await routeOrThrow(router, request(fixture)),
        prompt: "Hi",
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    answer = "overloaded";
    await expect(
      generateText({
        model: await routeOrThrow(router, request(fixture)),
        prompt: "Hi",
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    await settle();

    const calls = await getModelCalls(fixture.companyId);
    const dropped = calls.find((call) => call.errorCode !== "http_529");
    const refused = calls.find((call) => call.errorCode === "http_529");
    expect(dropped).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Unknown,
      gatewayLogId: null,
      costUsd: "0.000000",
    });
    expect(refused).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
      costUsd: "0.000000",
    });
  });
});

describe("ModelRouterRepo key-failure path", () => {
  it("answers a revoked key with KeyUnavailable and opens one system issue for the company", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    await new CompanySecretsRepo(env).updateCompanySecret({
      companyId: fixture.companyId,
      publicId: keyPublicId,
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Revoked },
    });
    mockCloudflare(() => anthropicMessage("unused"));
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    const first = await router.getModel(request(fixture));
    const second = await router.getModel(request(fixture));
    await settle();

    for (const routed of [first, second]) {
      expect(routed.isSuccess).toBe(false);
      expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
    }
    expect(gatewayRequests()).toHaveLength(0);
    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Revoked);

    const issues = await getQualityIssues(fixture.companyId);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      conversationId: fixture.conversationId,
      source: Schemas.QualityIssueSourceIntEnum.System,
      status: Schemas.QualityIssueStatusIntEnum.Open,
      issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
      feedbackId: null,
      createdBy: null,
    });
    expect(issues[0]?.note).toContain("Anthropic");

    // DEV_NOTE: The issue's critical event committed with it and was relayed after the commit
    const [outbox] = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.companyId, fixture.companyId)),
    );
    expect(outbox?.eventType).toBe("quality_issue.opened");
    const [logged] = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, outbox?.activityLogId ?? "")),
    );
    expect(logged).toMatchObject({
      entityType: "quality_issue",
      entityId: issues[0]?.id,
      entityAction: "opened",
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
    });
    expect(queue.sent.some((message) => message.outboxId === outbox?.id)).toBe(true);
  });

  it("opens no issue for a call with no conversation", async () => {
    const fixture = await createFixture();
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(
      request(fixture, { chatbotId: null, chatbotUserId: null, conversationId: null }),
    );
    await settle();

    expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
  });

  it("marks a key the provider rejects Invalid, opens the issue, and throws ModelUnavailableError", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare(() => anthropicError(401, "authentication_error"));
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    const failed = generateText({
      model: await routeOrThrow(router, request(fixture)),
      prompt: "Hi",
      maxRetries: 0,
    });
    await expect(failed).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(failed).rejects.toMatchObject({
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.KeyUnavailable,
    });
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Invalid);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(1);
    const [call] = await getModelCalls(fixture.companyId);
    expect(call).toMatchObject({
      errorCode: "http_401",
      inputTokens: 0,
      costUsd: "0.000000",
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
    });

    // DEV_NOTE: The next turn finds no active key and adds no second issue
    const next = await router.getModel(request(fixture));
    await settle();
    expect(next.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(1);
  });

  it("leaves a key alone on a 403: the key is fine, the model or project isn't", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare(() => anthropicError(403, "permission_error"));
    const { ctx, settle } = createCtx();

    const failed = generateText({
      model: await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture)),
      prompt: "Hi",
      maxRetries: 0,
    });
    // DEV_NOTE: Every failure reaches the caller as the one safe error; only a rejected key is KeyUnavailable
    await expect(failed).rejects.toMatchObject({
      name: "ModelUnavailableError",
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
    });
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Active);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
  });

  it("leaves the key alone when the gateway, not the provider, rejects the call", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare(() => gatewayUnauthorized());
    const { ctx, settle } = createCtx();

    const failed = generateText({
      model: await routeOrThrow(new ModelRouterRepo(routerEnv(), ctx), request(fixture)),
      prompt: "Hi",
      maxRetries: 0,
    });
    // DEV_NOTE: Every failure reaches the caller as the one safe error; only a rejected key is KeyUnavailable
    await expect(failed).rejects.toMatchObject({
      name: "ModelUnavailableError",
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
    });
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Active);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
    const [call] = await getModelCalls(fixture.companyId);
    expect(call?.errorCode).toBe("http_401");
  });

  it("never invalidates a key the admin replaced or revoked after the failing call started", async () => {
    const fixture = await createFixture();
    const replacedKey = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    const revokedKey = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.OpenAI);
    mockCloudflare((mocked) =>
      mocked.url.includes("/openai/")
        ? openAiKeyRejected()
        : anthropicError(401, "authentication_error"),
    );
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);
    const secretsRepo = new CompanySecretsRepo(env);

    // DEV_NOTE: Both models hold the old values; the admin changes each key before the call runs
    const anthropicModel = await routeOrThrow(router, request(fixture));
    const openAiModel = await routeOrThrow(router, request(fixture, { routing: mixedRouting }));
    await secretsRepo.updateCompanySecret({
      companyId: fixture.companyId,
      publicId: replacedKey,
      companySecret: { secret: `sk-ant-${crypto.randomUUID()}` },
    });
    await secretsRepo.updateCompanySecret({
      companyId: fixture.companyId,
      publicId: revokedKey,
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Revoked },
    });

    for (const model of [anthropicModel, openAiModel]) {
      await expect(generateText({ model, prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(
        ModelUnavailableError,
      );
    }
    await settle();

    expect(await getSecretStatus(replacedKey)).toBe(Schemas.CompanySecretStatusIntEnum.Active);
    expect(await getSecretStatus(revokedKey)).toBe(Schemas.CompanySecretStatusIntEnum.Revoked);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
  });

  it("opens one issue when key failures race, and adds each further provider to its note", async () => {
    const fixture = await createFixture();
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    // DEV_NOTE: No keys at all: four Anthropic turns at once, then two OpenAI turns
    const raced = await Promise.all(
      Array.from({ length: 4 }, async () => await router.getModel(request(fixture))),
    );
    await router.getModel(request(fixture, { routing: mixedRouting }));
    await router.getModel(request(fixture, { routing: mixedRouting }));
    await settle();

    for (const routed of raced) {
      expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
    }
    const issues = await getQualityIssues(fixture.companyId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.note).toContain("Anthropic");
    expect(issues[0]?.note?.match(/OpenAI/g)).toHaveLength(1);

    // DEV_NOTE: Which providers the issue covers is kept in its events, not read off the note
    const events = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select()
          .from(activityLog)
          .where(eq(activityLog.entityId, issues[0]?.id ?? "")),
    );
    expect(events.map((event) => event.entityAction).sort()).toEqual(["opened", "provider_added"]);
    expect(
      events.map((event) => Schemas.ZModelKeyFailureDetail.parse(event.detail).provider).sort(),
    ).toEqual([Schemas.ModelProviderEnum.Anthropic, Schemas.ModelProviderEnum.OpenAI]);
  });

  it("doesn't take an admin's edit of the note for a covered provider", async () => {
    const fixture = await createFixture();
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    await router.getModel(request(fixture));
    await settle();
    // DEV_NOTE: The note now names OpenAI, but no OpenAI key has failed yet
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(qualityIssues)
        .set({ note: "Triage: check the OpenAI and Anthropic keys" })
        .where(eq(qualityIssues.companyId, fixture.companyId));
    });
    await router.getModel(request(fixture, { routing: mixedRouting }));
    await settle();

    const [issue] = await getQualityIssues(fixture.companyId);
    expect(issue?.note).toContain("There's no active OpenAI model key");
  });

  it("invalidates a Google key the provider answers 401 UNAUTHENTICATED, end to end", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Google);
    mockCloudflare(() =>
      Response.json(
        {
          error: {
            code: 401,
            message: "Request had invalid credentials.",
            status: "UNAUTHENTICATED",
          },
        },
        { status: 401 },
      ),
    );
    const { ctx, settle } = createCtx();

    const failed = generateText({
      model: await routeOrThrow(
        new ModelRouterRepo(routerEnv(), ctx),
        request(fixture, { routing: mixedRouting, tier: Schemas.ModelTierEnum.Small }),
      ),
      prompt: "Hi",
    });
    await expect(failed).rejects.toMatchObject({
      failure: Schemas.ModelRouterFailureEnum.KeyUnavailable,
    });
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Invalid);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(1);
  });

  it("invalidates a Google key the provider answers API_KEY_INVALID, end to end", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Google);
    mockCloudflare(() =>
      Response.json(
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
            ],
          },
        },
        { status: 400 },
      ),
    );
    const { ctx, settle } = createCtx();

    const failed = generateText({
      model: await routeOrThrow(
        new ModelRouterRepo(routerEnv(), ctx),
        request(fixture, { routing: mixedRouting, tier: Schemas.ModelTierEnum.Small }),
      ),
      prompt: "Hi",
      maxRetries: 0,
    });
    await expect(failed).rejects.toMatchObject({
      failure: Schemas.ModelRouterFailureEnum.KeyUnavailable,
    });
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Invalid);
    const [issue] = await getQualityIssues(fixture.companyId);
    expect(issue?.note).toContain("Google rejected the model key");
  });

  it("invalidates once and opens one issue when two calls on the same key are rejected at once", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(fixture.companyId, Schemas.ModelProviderEnum.Anthropic);
    mockCloudflare(() => anthropicError(401, "authentication_error"));
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);
    const models = [
      await routeOrThrow(router, request(fixture)),
      await routeOrThrow(router, request(fixture)),
    ];

    const results = await Promise.allSettled(
      models.map(async (model) => await generateText({ model, prompt: "Hi", maxRetries: 0 })),
    );
    await settle();

    for (const result of results) {
      expect(result.status).toBe("rejected");
    }
    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Invalid);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(1);
  });
});

describe("ModelCallsRepo.backfillPendingUsage", () => {
  async function insertPendingCall(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    gatewayLogId: string | null,
    ageMs: number,
  ): Promise<string> {
    const publicId = Utility.generatePublicId();
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(modelCalls).values({
        publicId,
        companyId: fixture.companyId,
        conversationId: fixture.conversationId,
        taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
        tier: Schemas.ModelCallTierIntEnum.Mid,
        provider: Schemas.ModelProviderEnum.Anthropic,
        model: "claude-sonnet-5-5",
        gatewayLogId,
        errorCode: "aborted",
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
        createdAt: new Date(Date.now() - ageMs),
      });
    });
    return publicId;
  }

  async function getCall(publicId: string) {
    return await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.publicId, publicId));
      return row;
    });
  }

  it("fills Pending rows from the gateway log, waits for young or missing logs, and gives up after the window", async () => {
    const fixture = await createFixture();
    const minute = 60_000;
    const withLog = await insertPendingCall(fixture, "log-found", 2 * minute);
    const tooYoung = await insertPendingCall(fixture, "log-young", 10_000);
    const notYetLogged = await insertPendingCall(fixture, "log-missing", 2 * minute);
    const expired = await insertPendingCall(fixture, "log-missing", 2 * 60 * minute);
    const noLogId = await insertPendingCall(fixture, null, 2 * minute);
    mockCloudflare((mocked) =>
      mocked.url.endsWith("/log-found")
        ? Response.json({
            success: true,
            result: { id: "log-found", tokens_in: 1000, tokens_out: 100 },
          })
        : Response.json(
            { success: false, errors: [{ code: 7003, message: "Not found" }] },
            { status: 404 },
          ),
    );

    const result = await new ModelCallsRepo(routerEnv()).backfillPendingUsage({
      companyIds: [fixture.companyId],
    });

    expect(result).toMatchObject({
      isSuccess: true,
      backfilledCount: 1,
      unknownCount: 2,
      stillPendingCount: 1,
    });
    // 1000 input × $2.5 (the cache-write price, the dearer: no cache split in the log) + 100 output × $10, per 1M
    expect(await getCall(withLog)).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Backfilled,
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: "0.003500",
    });
    expect((await getCall(tooYoung))?.usageStatus).toBe(
      Schemas.ModelCallUsageStatusIntEnum.Pending,
    );
    expect((await getCall(notYetLogged))?.usageStatus).toBe(
      Schemas.ModelCallUsageStatusIntEnum.Pending,
    );
    expect((await getCall(expired))?.usageStatus).toBe(Schemas.ModelCallUsageStatusIntEnum.Unknown);
    expect((await getCall(noLogId))?.usageStatus).toBe(Schemas.ModelCallUsageStatusIntEnum.Unknown);

    const logRequests = mockedRequests.filter((mocked) => mocked.url.startsWith(LOGS_URL));
    expect(logRequests.map((mocked) => mocked.url.slice(LOGS_URL.length + 1)).sort()).toEqual([
      "log-found",
      "log-missing",
      "log-missing",
    ]);
    for (const mocked of logRequests) {
      expect(mocked.headers.get("authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
    }

    // DEV_NOTE: A second sweep leaves settled rows alone
    const again = await new ModelCallsRepo(routerEnv()).backfillPendingUsage({
      companyIds: [fixture.companyId],
    });
    expect(again).toMatchObject({ backfilledCount: 0, unknownCount: 0, stillPendingCount: 1 });
  });

  it("doesn't let rows whose log is late starve a newer row that could settle", async () => {
    const fixture = await createFixture();
    const stuckRows = Constants.MODEL_CALL_BACKFILL_BATCH_SIZE + 5;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(modelCalls).values(
        Array.from({ length: stuckRows }, (_, index) => ({
          publicId: Utility.generatePublicId(),
          companyId: fixture.companyId,
          taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
          tier: Schemas.ModelCallTierIntEnum.Mid,
          provider: Schemas.ModelProviderEnum.Anthropic,
          model: "claude-sonnet-5-5",
          gatewayLogId: `log-late-${index}`,
          usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
          createdAt: new Date(Date.now() - 5 * 60_000),
        })),
      );
    });
    const resolvable = await insertPendingCall(fixture, "log-ready", 2 * 60_000);
    mockCloudflare((mocked) =>
      mocked.url.endsWith("/log-ready")
        ? Response.json({ success: true, result: { tokens_in: 10, tokens_out: 1 } })
        : Response.json({ success: false }, { status: 404 }),
    );
    const repo = new ModelCallsRepo(routerEnv());

    await repo.backfillPendingUsage({ companyIds: [fixture.companyId] });
    await repo.backfillPendingUsage({ companyIds: [fixture.companyId] });

    expect((await getCall(resolvable))?.usageStatus).toBe(
      Schemas.ModelCallUsageStatusIntEnum.Backfilled,
    );
  });

  it("works through more Pending rows than one batch, a batch per sweep", async () => {
    const fixture = await createFixture();
    const rows = Constants.MODEL_CALL_BACKFILL_BATCH_SIZE + 10;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(modelCalls).values(
        Array.from({ length: rows }, (_, index) => ({
          publicId: Utility.generatePublicId(),
          companyId: fixture.companyId,
          taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
          tier: Schemas.ModelCallTierIntEnum.Mid,
          provider: Schemas.ModelProviderEnum.Anthropic,
          model: "claude-sonnet-5-5",
          gatewayLogId: `log-${index}`,
          usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
          createdAt: new Date(Date.now() - 2 * 60_000 - index),
        })),
      );
    });
    mockCloudflare(() =>
      Response.json({ success: true, result: { tokens_in: 10, tokens_out: 1 } }),
    );
    const repo = new ModelCallsRepo(routerEnv());

    const first = await repo.backfillPendingUsage({ companyIds: [fixture.companyId] });
    const second = await repo.backfillPendingUsage({ companyIds: [fixture.companyId] });

    expect(first.backfilledCount).toBe(Constants.MODEL_CALL_BACKFILL_BATCH_SIZE);
    expect(second.backfilledCount).toBe(10);
    const pending = (await getModelCalls(fixture.companyId)).filter(
      (call) => call.usageStatus === Schemas.ModelCallUsageStatusIntEnum.Pending,
    );
    expect(pending).toHaveLength(0);
  });

  it("settles each row once when sweeps overlap", async () => {
    const fixture = await createFixture();
    const publicIds = await Promise.all(
      Array.from(
        { length: 5 },
        async () => await insertPendingCall(fixture, "log-shared", 2 * 60_000),
      ),
    );
    mockCloudflare(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ success: true, result: { tokens_in: 10, tokens_out: 1 } });
    });

    const results = await Promise.all([
      new ModelCallsRepo(routerEnv()).backfillPendingUsage({ companyIds: [fixture.companyId] }),
      new ModelCallsRepo(routerEnv()).backfillPendingUsage({ companyIds: [fixture.companyId] }),
    ]);

    expect(results.reduce((sum, result) => sum + (result.backfilledCount ?? 0), 0)).toBe(5);
    for (const publicId of publicIds) {
      expect((await getCall(publicId))?.usageStatus).toBe(
        Schemas.ModelCallUsageStatusIntEnum.Backfilled,
      );
    }
  });

  it("keeps a row Pending while the log lookup fails", async () => {
    const fixture = await createFixture();
    const publicId = await insertPendingCall(fixture, "log-flaky", 2 * 60_000);
    mockCloudflare(() => Response.json({ success: false }, { status: 503 }));

    const result = await new ModelCallsRepo(routerEnv()).backfillPendingUsage({
      companyIds: [fixture.companyId],
    });

    expect(result.stillPendingCount).toBe(1);
    expect((await getCall(publicId))?.usageStatus).toBe(
      Schemas.ModelCallUsageStatusIntEnum.Pending,
    );
  });
});

describe("ModelRouterRepo tenancy (as diletta_app)", () => {
  it("never uses another company's key", async () => {
    const owner = await createFixture();
    const other = await createFixture();
    await addModelKey(owner.companyId, Schemas.ModelProviderEnum.Anthropic);
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(request(other));
    await settle();

    expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
  });

  it("rejects a model call or system issue that points at another company's conversation", async () => {
    const owner = await createFixture();
    const other = await createFixture();
    const db = getDbClient(env);

    const call = await withTenant(db, other.companyId, async (tx) => {
      return await new ModelCallsDAL().createModelCall(tx, {
        companyId: other.companyId,
        chatbotId: null,
        chatbotUserId: null,
        conversationId: owner.conversationId,
        evalRunId: null,
        turnId: null,
        taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
        tier: Schemas.ModelCallTierIntEnum.Mid,
        provider: Schemas.ModelProviderEnum.Anthropic,
        model: "claude-sonnet-5-5",
        gatewayLogId: null,
        inputTokens: 0,
        outputTokens: null,
        cachedTokens: 0,
        costUsd: "0",
        latencyMs: null,
        wasEscalated: false,
        errorCode: null,
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
      });
    });
    expect(call.isSuccess).toBe(false);
    expect(call.message).toBe("Conversation not found");

    const issue = await withTenant(db, other.companyId, async (tx) => {
      return await new QualityIssuesDAL().createSystemQualityIssue(tx, {
        companyId: other.companyId,
        conversationId: owner.conversationId,
        issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
        note: null,
      });
    });
    expect(issue.isSuccess).toBe(false);
    expect(issue.message).toBe("Conversation not found");

    // DEV_NOTE: The owner's open issue is invisible to the other company's lookup
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(qualityIssues).values({
        publicId: Utility.generatePublicId(),
        companyId: owner.companyId,
        conversationId: owner.conversationId,
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
      });
    });
    const open: Schemas.QualityIssueDALResponse = await withTenant(
      db,
      other.companyId,
      async (tx) => {
        return await new QualityIssuesDAL().getOpenSystemQualityIssue(tx, {
          companyId: other.companyId,
          issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
        });
      },
    );
    expect(open.isSuccess).toBe(true);
    expect(open.qualityIssue).toBeUndefined();
  });

  it("settles only the company's own Pending rows", async () => {
    const owner = await createFixture();
    const other = await createFixture();
    const publicId = Utility.generatePublicId();
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(modelCalls).values({
        publicId,
        companyId: owner.companyId,
        taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
        tier: Schemas.ModelCallTierIntEnum.Mid,
        provider: Schemas.ModelProviderEnum.Anthropic,
        model: "claude-sonnet-5-5",
        gatewayLogId: "log-owner",
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
      });
    });

    const settled: Schemas.ModelCallDALResponse = await withTenant(
      getDbClient(env),
      other.companyId,
      async (tx) => {
        return await new ModelCallsDAL().settleModelCallUsage(tx, {
          companyId: other.companyId,
          publicId,
          usageStatus: Schemas.ModelCallUsageStatusIntEnum.Unknown,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        });
      },
    );
    expect(settled.isSuccess).toBe(false);
    expect(settled.isNotFound).toBe(true);
  });
});

describe("AiGatewayProvider.isRejectedKeyError", () => {
  const apiError = (statusCode: number, body: unknown) =>
    new APICallError({
      message: "Provider error",
      url: `${GATEWAY_URL}/provider`,
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify(body),
    });

  it("matches each provider's own rejected-key answer", () => {
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Anthropic,
        apiError(401, { type: "error", error: { type: "authentication_error", message: "bad" } }),
      ),
    ).toBe(true);
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.OpenAI,
        apiError(401, { error: { message: "Incorrect API key", code: "invalid_api_key" } }),
      ),
    ).toBe(true);
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Google,
        apiError(400, {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            details: [{ reason: "API_KEY_INVALID" }],
          },
        }),
      ),
    ).toBe(true);
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Google,
        apiError(401, { error: { code: 401, status: "UNAUTHENTICATED" } }),
      ),
    ).toBe(true);
  });

  it("ignores 403s, gateway errors, other statuses and non-HTTP errors", () => {
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Anthropic,
        apiError(403, { type: "error", error: { type: "permission_error" } }),
      ),
    ).toBe(false);
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Google,
        apiError(403, { error: { code: 403, status: "PERMISSION_DENIED" } }),
      ),
    ).toBe(false);
    const gatewayBody = { success: false, error: [{ code: 2009, message: "Unauthorized" }] };
    for (const provider of Object.values(Schemas.ModelProviderEnum)) {
      expect(AiGatewayProvider.isRejectedKeyError(provider, apiError(401, gatewayBody))).toBe(
        false,
      );
      expect(AiGatewayProvider.isRejectedKeyError(provider, new Error("boom"))).toBe(false);
    }
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Anthropic,
        apiError(500, { type: "error", error: { type: "api_error" } }),
      ),
    ).toBe(false);
    expect(
      AiGatewayProvider.isRejectedKeyError(
        Schemas.ModelProviderEnum.Google,
        apiError(400, { error: { code: 400, status: "INVALID_ARGUMENT" } }),
      ),
    ).toBe(false);
  });
});
