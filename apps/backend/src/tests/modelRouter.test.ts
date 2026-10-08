import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { APICallError, generateText, streamText } from "ai";
import * as Schemas from "@app/schemas";
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
import ModelRouterRepo, { ModelUnavailableError } from "@/repositories/ModelRouterRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch with the real staging master key. Each scenario gets its own company
// (created through CompaniesRepo, so it has a company key) with a chatbot, a chatbot user and a conversation inserted
// as owner fixtures (the conversations DAL comes with M2-2), and its model key created through CompanySecretsRepo.
// The router runs as diletta_app (HYPERDRIVE), so RLS applies. AI Gateway is never reached: fetch is replaced for
// gateway URLs only, and records each request so the tests can check the URL, headers and body the router sent.
// EVENTS_QUEUE is a recording fake. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];
const GATEWAY_TOKEN = "test-gateway-token";
const GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}`;

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

interface Fixture {
  companyId: string;
  chatbotId: string;
  chatbotUserId: string;
  conversationId: string;
}

async function createFixture(): Promise<Fixture> {
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
  secret: string,
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

const routing: Schemas.ConfigSpec["routing"] = {
  small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
  mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
  top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
  defaultTier: Schemas.ModelTierEnum.Mid,
};

function request(
  fixture: Fixture,
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
    routing,
    ...overrides,
  };
}

// DEV_NOTE: Gateway stand-in. respond builds the answer for each gateway request; every other URL goes to the real
// fetch untouched.
interface GatewayRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}
const gatewayRequests: GatewayRequest[] = [];

function mockGateway(respond: (request: GatewayRequest) => Response) {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const target = new Request(input, init);
    if (!target.url.startsWith("https://gateway.ai.cloudflare.com/")) {
      return await realFetch(input, init);
    }
    const body = (await target.json()) as Record<string, unknown>;
    const recorded = { url: target.url, headers: target.headers, body };
    gatewayRequests.push(recorded);
    return respond(recorded);
  });
}

const anthropicMessage = (model: string) =>
  Response.json(
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Hello from the gateway" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
      },
    },
    { headers: { "cf-aig-log-id": "log-generate" } },
  );

const anthropicStream = (model: string) => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 800, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Streamed" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 50 },
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-stream" },
  });
};

const anthropicKeyRejected = () =>
  Response.json(
    { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
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
  gatewayRequests.length = 0;
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
    mockGateway((gatewayRequest) => anthropicMessage(String(gatewayRequest.body.model)));
    const { ctx, settle } = createCtx();
    const params = request(fixture);

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(params);
    expect(routed.isSuccess).toBe(true);
    if (!routed.model) throw new Error("No model");

    const result = await generateText({ model: routed.model, prompt: "Hi" });
    expect(result.text).toBe("Hello from the gateway");
    await settle();

    expect(gatewayRequests).toHaveLength(1);
    const [sent] = gatewayRequests;
    expect(sent?.url).toBe(`${GATEWAY_URL}/anthropic/v1/messages`);
    expect(sent?.body.model).toBe("claude-sonnet-5-5");
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
    });
    // 1000 uncached × $2 + 500 cache reads × $0.1 + 200 output × $10, per 1M tokens
    expect(call?.costUsd).toBe("0.004050");
    expect(call?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps an explicit tier to its model and records a streamed call once the stream ends", async () => {
    const fixture = await createFixture();
    await addModelKey(
      fixture.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
    mockGateway((gatewayRequest) => anthropicStream(String(gatewayRequest.body.model)));
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(
      request(fixture, { tier: Schemas.ModelTierEnum.Small }),
    );
    if (!routed.model) throw new Error(`No model: ${routed.message}`);

    const result = streamText({ model: routed.model, prompt: "Hi" });
    expect(await result.text).toBe("Streamed");
    await settle();

    expect(gatewayRequests[0]?.body.model).toBe("claude-haiku-4-5");
    const [call] = await getModelCalls(fixture.companyId);
    expect(call).toMatchObject({
      tier: Schemas.ModelCallTierIntEnum.Small,
      model: "claude-haiku-4-5",
      gatewayLogId: "log-stream",
      inputTokens: 800,
      outputTokens: 50,
      errorCode: null,
    });
    // 800 input × $1 + 50 output × $5, per 1M tokens
    expect(call?.costUsd).toBe("0.001050");
  });

  it("refuses a model missing from the price table before any key read or gateway call", async () => {
    const fixture = await createFixture();
    await addModelKey(
      fixture.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
    mockGateway(() => anthropicMessage("unused"));
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(
      request(fixture, {
        routing: {
          ...routing,
          mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-unlisted" },
        },
      }),
    );
    await settle();

    expect(routed.isSuccess).toBe(false);
    expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.ModelNotPriced);
    expect(routed.model).toBeUndefined();
    expect(gatewayRequests).toHaveLength(0);
    expect(await getModelCalls(fixture.companyId)).toHaveLength(0);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
  });
});

describe("ModelRouterRepo key-failure path", () => {
  it("answers a revoked key with KeyUnavailable and opens one system issue for the company", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(
      fixture.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
    await new CompanySecretsRepo(env).updateCompanySecret({
      companyId: fixture.companyId,
      publicId: keyPublicId,
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Revoked },
    });
    mockGateway(() => anthropicMessage("unused"));
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    const first = await router.getModel(request(fixture));
    const second = await router.getModel(request(fixture));
    await settle();

    for (const routed of [first, second]) {
      expect(routed.isSuccess).toBe(false);
      expect(routed.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
    }
    expect(gatewayRequests).toHaveLength(0);

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
    const keyPublicId = await addModelKey(
      fixture.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
    mockGateway(() => anthropicKeyRejected());
    const { ctx, settle } = createCtx();
    const router = new ModelRouterRepo(routerEnv(), ctx);

    const routed = await router.getModel(request(fixture));
    if (!routed.model) throw new Error(`No model: ${routed.message}`);

    const failed = generateText({ model: routed.model, prompt: "Hi", maxRetries: 0 });
    await expect(failed).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(failed).rejects.toMatchObject({
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.KeyUnavailable,
    });
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Invalid);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(1);
    const [call] = await getModelCalls(fixture.companyId);
    expect(call).toMatchObject({ errorCode: "http_401", inputTokens: 0, costUsd: "0.000000" });

    // DEV_NOTE: The next turn finds no active key and adds no second issue
    const next = await router.getModel(request(fixture));
    await settle();
    expect(next.failure).toBe(Schemas.ModelRouterFailureEnum.KeyUnavailable);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(1);
  });

  it("leaves the key alone when the gateway, not the provider, rejects the call", async () => {
    const fixture = await createFixture();
    const keyPublicId = await addModelKey(
      fixture.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
    mockGateway(() => gatewayUnauthorized());
    const { ctx, settle } = createCtx();

    const routed = await new ModelRouterRepo(routerEnv(), ctx).getModel(request(fixture));
    if (!routed.model) throw new Error(`No model: ${routed.message}`);

    const failed = generateText({ model: routed.model, prompt: "Hi", maxRetries: 0 });
    await expect(failed).rejects.not.toBeInstanceOf(ModelUnavailableError);
    await settle();

    expect(await getSecretStatus(keyPublicId)).toBe(Schemas.CompanySecretStatusIntEnum.Active);
    expect(await getQualityIssues(fixture.companyId)).toHaveLength(0);
    const [call] = await getModelCalls(fixture.companyId);
    expect(call?.errorCode).toBe("http_401");
  });

  it("answers ServerError without a gateway token, and opens no issue", async () => {
    const fixture = await createFixture();
    await addModelKey(
      fixture.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
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

describe("ModelRouterRepo tenancy (as diletta_app)", () => {
  it("never uses another company's key", async () => {
    const owner = await createFixture();
    const other = await createFixture();
    await addModelKey(
      owner.companyId,
      Schemas.ModelProviderEnum.Anthropic,
      `sk-ant-${crypto.randomUUID()}`,
    );
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
        apiError(403, { error: { code: 403, status: "PERMISSION_DENIED" } }),
      ),
    ).toBe(true);
  });

  it("ignores gateway errors, other statuses and non-HTTP errors", () => {
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
