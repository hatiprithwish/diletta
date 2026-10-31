import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { MockLanguageModelV4 } from "ai/test";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  chatbotConfigs,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  docGapClusters,
  docGaps,
  eventOutbox,
  messages,
  modelCalls,
  qualityIssues,
} from "@/db/tables";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import worker from "@/index";
import DocGapClustersDAL from "@/data-access-layer/DocGapClustersDAL";
import ChatbotHealthProvider from "@/providers/chatbotHealth";
import DocGapQualityProvider from "@/providers/docGapQuality";
import consumeEvents from "@/queues/EventsConsumer";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import Utility from "@/utils/Utility";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const mocks = vi.hoisted(() => ({ getModel: vi.fn() }));

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: The model router stand-in: each test sets the verdict the rewrite answers, or a router failure
vi.mock("@/repositories/ModelRouterRepo", () => ({
  default: class {
    getModel = mocks.getModel;
  },
}));

// DEV_NOTE: Clerk stand-in. "Authorization: Bearer <clerkUserId>" signs in as that Clerk user.
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

// DEV_NOTE: M5-6 "Done when": no Quality item per single question. Candidates go the real way: ConversationsRepo.recordTurn
// writes the event, consumeEvents handles it, all as diletta_app (RLS applies); fixtures and checks run as the owner.
// Tests hit the Neon staging branch; afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
const adminA = `user_gap_${crypto.randomUUID()}`;
const { LowRetrieval, Idk } = Schemas.DocGapSignalIntEnum;
const { Open, Answered, Dismissed } = Schemas.DocGapClusterStatusIntEnum;

let companyA = "";
let companyB = "";
let botId = "";
let botPublicId = "";
let otherBotId = "";
let userId = "";

// DEV_NOTE: One axis per topic, so questions on a topic are identical and topics are orthogonal (similarity 0)
let nextAxis = 0;
const newTopic = () => {
  const axis = nextAxis++;
  return Array.from({ length: 1024 }, (_, index) => (index === axis ? 1 : 0));
};

const embedEnv = (embedding: number[] | null): Env => ({
  ...env,
  AI: {
    aiGatewayLogId: "log_gap",
    run: vi.fn(async () => {
      if (embedding === null) throw new Error("embed down");
      return { data: [embedding] };
    }),
  } as unknown as Ai,
});

function mockVerdict(answer: Schemas.DocGapRewriteOutput | string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [
          {
            type: "text" as const,
            text: typeof answer === "string" ? answer : JSON.stringify(answer),
          },
        ],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  mocks.getModel.mockResolvedValue({ isSuccess: true, model });
  return prompts;
}

const unanswered = (questionGeneric = "How do I archive a register?") => ({
  wasUnanswered: true,
  questionGeneric,
});

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

const session = (
  conversation: { id: string; publicId: string },
  overrides: Partial<Schemas.ConversationSession> = {},
): Schemas.ConversationSession => ({
  companyId: companyA,
  chatbotId: botId,
  chatbotPublicId: botPublicId,
  chatbotName: "Support",
  chatbotUserId: userId,
  conversationId: conversation.id,
  conversationPublicId: conversation.publicId,
  eval: null,
  ...overrides,
});

async function newUser() {
  return await withOwnerDb(async (ownerDb) => {
    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    return user!.id;
  });
}

// DEV_NOTE: A new user by default: the Quality floor counts users, so a test shares one only on purpose
async function newConversation(chatbotId = botId, chatbotUserId?: string) {
  const owner = chatbotUserId ?? (await newUser());
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        chatbotUserId: owner,
        chatbotId,
      })
      .returning({ id: conversations.id, publicId: conversations.publicId });
    return row!;
  });
}

// DEV_NOTE: One turn through recordTurn; answers the outbox id of its candidate event, if any
async function recordQuestion(
  conversation: { id: string; publicId: string },
  params: {
    chatbotId?: string;
    signal?: Schemas.DocGapSignalIntEnum | null;
    sessionOverrides?: Partial<Schemas.ConversationSession>;
    question?: string;
  } = {},
) {
  const turnId = Utility.generateUlid();
  const repo = new ConversationsRepo(env);
  return await repo.recordTurn({
    session: session(conversation, {
      chatbotId: params.chatbotId ?? botId,
      ...params.sessionOverrides,
    }),
    turnId,
    title: null,
    docGapSignal: params.signal === undefined ? Idk : params.signal,
    messages: [
      {
        sessionMessageId: `u_${crypto.randomUUID()}`,
        role: Schemas.MessageRoleIntEnum.User,
        content: { text: params.question ?? "Priya Shah here: how do I archive register 88213?" },
      },
      {
        sessionMessageId: `a_${crypto.randomUUID()}`,
        role: Schemas.MessageRoleIntEnum.Assistant,
        content: { text: "I don't know." },
      },
    ],
  });
}

const eventsOf = async (outboxIds: string[]) =>
  await withOwnerDb(async (ownerDb) => {
    return await ownerDb.select().from(eventOutbox).where(inArray(eventOutbox.id, outboxIds));
  });

const message = (body: unknown) => ({
  id: crypto.randomUUID(),
  timestamp: new Date(),
  body,
  attempts: 1,
  ack: vi.fn(),
  retry: vi.fn(),
});

// DEV_NOTE: Hands the events to the consumer as the queue would; answers the message so a test can read ack / retry
async function deliver(outboxId: string, embedding: number[] | null) {
  const [row] = await eventsOf([outboxId]);
  const delivered = message({
    outboxId: row!.id,
    companyId: row!.companyId,
    activityLogId: row!.activityLogId,
    eventType: row!.eventType,
    dedupeKey: row!.dedupeKey,
  });
  const ctx = createExecutionContext();
  await consumeEvents(
    {
      messages: [delivered],
      queue: "diletta-events-local",
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } as unknown as MessageBatch<unknown>,
    embedEnv(embedding),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return delivered;
}

async function ask(
  conversation: { id: string; publicId: string },
  embedding: number[],
  params: { chatbotId?: string; question?: string } = {},
) {
  const recorded = await recordQuestion(conversation, { chatbotId: params.chatbotId });
  expect(recorded.outboxIds).toHaveLength(1);
  return await deliver(recorded.outboxIds![0]!, embedding);
}

const clusterFor = async (questionGeneric: string) =>
  await withOwnerDb(async (ownerDb) => {
    const rows = await ownerDb
      .select({
        id: docGapClusters.id,
        publicId: docGapClusters.publicId,
        chatbotId: docGapClusters.chatbotId,
        label: docGapClusters.label,
        questionCount: docGapClusters.questionCount,
        status: docGapClusters.status,
      })
      .from(docGapClusters)
      .where(
        and(eq(docGapClusters.companyId, companyA), eq(docGapClusters.label, questionGeneric)),
      );
    return rows;
  });

const itemsOf = async (clusterId: string) =>
  await withOwnerDb(async (ownerDb) => {
    return await ownerDb
      .select()
      .from(qualityIssues)
      .where(eq(qualityIssues.docGapClusterId, clusterId));
  });

// DEV_NOTE: Letters only: a run of digits (as in a UUID) is what the personal details check refuses
const label = () =>
  `Topic ${crypto.randomUUID().replace(/[^a-f]/g, "")}${nextAxis}x?`.replace(/\d/g, "q");

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Gaps A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Gaps B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    await ownerDb.insert(admins).values({ clerkUserId: adminA, companyId: companyA });
    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" },
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Sales" },
      ])
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    botId = bots[0]!.id;
    botPublicId = bots[0]!.publicId;
    otherBotId = bots[1]!.id;

    const normalized = Schemas.normalizeConfigBody({
      persona: { instructions: "You help facility managers." },
      procedures: [],
      tools: [],
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
    if (!normalized.body || !normalized.schemaVersion) throw new Error("Config body invalid");
    await ownerDb.insert(chatbotConfigs).values(
      [botId, otherBotId].map((chatbotId, index) => ({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        chatbotId,
        configVersion: 1,
        schemaVersion: normalized.schemaVersion!,
        status: Schemas.ChatbotConfigStatusIntEnum.Published,
        body: normalized.body!,
        bodyHash: `gaps-${index}`,
        publishedAt: new Date(),
      })),
    );
    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    userId = user!.id;
  });
});

beforeEach(() => {
  mocks.getModel.mockReset();
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(docGaps).where(inArray(docGaps.companyId, companyIds));
    await ownerDb.delete(docGapClusters).where(inArray(docGapClusters.companyId, companyIds));
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(eq(admins.clerkUserId, adminA));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("recordTurn: the candidate event", () => {
  it("records one event with ids only, and none for a retry, a non-candidate or an eval turn", async () => {
    const conversation = await newConversation();
    const recorded = await recordQuestion(conversation, { signal: LowRetrieval });
    expect(recorded.isSuccess).toBe(true);
    expect(recorded.outboxIds).toHaveLength(1);
    const [event] = await eventsOf(recorded.outboxIds!);
    expect(event?.eventType).toBe(Schemas.DOC_GAP_CANDIDATE_EVENT_TYPE);
    const [log] = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .select()
        .from(activityLog)
        .where(eq(activityLog.id, event!.activityLogId));
    });
    expect(JSON.stringify(log?.detail)).not.toContain("Priya");
    expect(Schemas.ZDocGapCandidateDetail.safeParse(log?.detail).success).toBe(true);

    expect((await recordQuestion(conversation, { signal: null })).outboxIds).toBeUndefined();
    const evalTurn = await recordQuestion(conversation, {
      sessionOverrides: {
        eval: { evalRunId: "1", chatbotConfigId: "1", connectionId: "1" },
      },
    });
    expect(evalTurn.isSuccess).toBe(true);
    expect(evalTurn.outboxIds).toBeUndefined();
  });
});

describe("consumer: a candidate becomes a gap", () => {
  it("rewrites on the small tier as a background call, stores no chat text, and one question opens no Quality item", async () => {
    const question = label();
    const prompts = mockVerdict(unanswered(question));
    const conversation = await newConversation();
    const delivered = await ask(conversation, newTopic());
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(delivered.retry).not.toHaveBeenCalled();

    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: companyA,
        chatbotId: botId,
        conversationId: null,
        chatbotUserId: null,
        turnId: null,
        evalRunId: null,
        taskType: Schemas.ModelTaskTypeEnum.DocGapRewrite,
        tier: Schemas.ModelTierEnum.Small,
      }),
    );
    expect(prompts[0]).toContain("I don't know.");

    const [cluster] = await clusterFor(question);
    expect(cluster?.questionCount).toBe(1);
    expect(cluster?.chatbotId).toBe(botId);
    expect(await itemsOf(cluster!.id)).toHaveLength(0);

    const gaps = await withOwnerDb(async (ownerDb) => {
      return await ownerDb.select().from(docGaps).where(eq(docGaps.clusterId, cluster!.id));
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.questionGeneric).toBe(question);
    expect(gaps[0]?.questionGeneric).not.toContain("Priya");
    expect(gaps[0]?.conversationId).toBe(conversation.id);

    const calls = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .select()
        .from(modelCalls)
        .where(
          and(
            eq(modelCalls.companyId, companyA),
            eq(modelCalls.taskType, Schemas.ModelTaskTypeEnum.DocGapEmbed),
          ),
        );
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.conversationId === null)).toBe(true);
  });

  it("stores nothing when the verdict says answered, or the rewrite keeps personal details", async () => {
    const conversation = await newConversation();
    const countGaps = async () =>
      await withOwnerDb(async (ownerDb) => {
        const rows = await ownerDb
          .select({ id: docGaps.id })
          .from(docGaps)
          .where(eq(docGaps.conversationId, conversation.id));
        return rows.length;
      });

    mockVerdict({ wasUnanswered: false, questionGeneric: "" });
    expect((await ask(conversation, newTopic())).ack).toHaveBeenCalledOnce();
    mockVerdict(unanswered("How does priya@example.com archive a register?"));
    expect((await ask(conversation, newTopic())).ack).toHaveBeenCalledOnce();
    mockVerdict(unanswered("How do I archive register 882133?"));
    expect((await ask(conversation, newTopic())).ack).toHaveBeenCalledOnce();
    expect(await countGaps()).toBe(0);
  });

  it("doesn't pay for the rewrite again when a retry follows a failed embed", async () => {
    const question = label();
    const prompts = mockVerdict(unanswered(question));
    const recorded = await recordQuestion(await newConversation());
    const outboxId = recorded.outboxIds![0]!;
    const failed = await deliver(outboxId, null);
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(1);

    const retried = await deliver(outboxId, newTopic());
    expect(retried.ack).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(1);
    expect((await clusterFor(question))[0]?.questionCount).toBe(1);
  });

  it("writes nothing on a redelivered event", async () => {
    const question = label();
    mockVerdict(unanswered(question));
    const recorded = await recordQuestion(await newConversation());
    const outboxId = recorded.outboxIds![0]!;
    await deliver(outboxId, newTopic());
    mocks.getModel.mockClear();
    const again = await deliver(outboxId, newTopic());
    expect(again.ack).toHaveBeenCalledOnce();
    expect(mocks.getModel).not.toHaveBeenCalled();
    const [cluster] = await clusterFor(question);
    expect(cluster?.questionCount).toBe(1);
  });

  it("drops on a spent budget, retries on a provider failure or a failed embed", async () => {
    const conversation = await newConversation();
    mocks.getModel.mockResolvedValue({
      isSuccess: false,
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    const refused = await ask(conversation, newTopic());
    expect(refused.ack).toHaveBeenCalledOnce();
    expect(refused.retry).not.toHaveBeenCalled();

    mocks.getModel.mockResolvedValue({
      isSuccess: false,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
    });
    const down = await ask(conversation, newTopic());
    expect(down.retry).toHaveBeenCalledOnce();
    expect(down.ack).not.toHaveBeenCalled();

    mockVerdict(unanswered(label()));
    const recorded = await recordQuestion(conversation);
    const noEmbed = await deliver(recorded.outboxIds![0]!, null);
    expect(noEmbed.retry).toHaveBeenCalledOnce();

    mockVerdict("not json");
    const unusable = await ask(conversation, newTopic());
    expect(unusable.retry).toHaveBeenCalledOnce();
  });

  it("never reads another company's event", async () => {
    const recorded = await recordQuestion(await newConversation());
    const [event] = await eventsOf(recorded.outboxIds!);
    const stolen = message({
      outboxId: event!.id,
      companyId: companyB,
      activityLogId: event!.activityLogId,
      eventType: event!.eventType,
      dedupeKey: event!.dedupeKey,
    });
    const ctx = createExecutionContext();
    await consumeEvents(
      { messages: [stolen], queue: "q" } as unknown as MessageBatch<unknown>,
      embedEnv(newTopic()),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(stolen.ack).toHaveBeenCalledOnce();
    expect(mocks.getModel).not.toHaveBeenCalled();
  });
});

describe("clustering", () => {
  it("joins a close question, starts a new group for a far one, and keeps chatbots apart", async () => {
    const topic = newTopic();
    const first = label();
    mockVerdict(unanswered(first));
    await ask(await newConversation(), topic);
    mockVerdict(unanswered(label()));
    await ask(await newConversation(), topic);
    const [joined] = await clusterFor(first);
    expect(joined?.questionCount).toBe(2);

    const far = label();
    mockVerdict(unanswered(far));
    await ask(await newConversation(), newTopic());
    expect((await clusterFor(far))[0]?.questionCount).toBe(1);

    const sales = label();
    mockVerdict(unanswered(sales));
    await ask(await newConversation(otherBotId), topic, { chatbotId: otherBotId });
    const [salesGroup] = await clusterFor(sales);
    expect(salesGroup?.chatbotId).toBe(otherBotId);
    expect(salesGroup?.questionCount).toBe(1);
  });

  it("opens one item at 5 questions from 3 users, not before, and no second one as it grows", async () => {
    const topic = newTopic();
    const first = label();
    mockVerdict(unanswered(first));
    const chats = [await newConversation(), await newConversation(), await newConversation()];
    await ask(chats[0]!, topic);
    const [cluster] = await clusterFor(first);
    mockVerdict(unanswered(label()));
    await ask(chats[0]!, topic);
    await ask(chats[1]!, topic);
    await ask(chats[1]!, topic);
    expect(await itemsOf(cluster!.id)).toHaveLength(0);

    await ask(chats[2]!, topic);
    const items = await itemsOf(cluster!.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe(Schemas.QualityIssueSourceIntEnum.System);
    expect(items[0]?.issueType).toBe(Schemas.QualityIssueTypeIntEnum.KnowledgeGap);
    expect(items[0]?.conversationId).toBeNull();
    expect(items[0]?.chatbotId).toBe(botId);
    expect(items[0]?.note).toContain(first);
    const opened = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyA),
            eq(activityLog.entityId, items[0]!.id),
            eq(activityLog.entityAction, Schemas.QualityIssueEntityActionEnum.Opened),
          ),
        );
    });
    expect(opened).toHaveLength(1);

    await ask(chats[2]!, topic);
    await ask(await newConversation(), topic);
    expect(await itemsOf(cluster!.id)).toHaveLength(1);
    expect((await clusterFor(first))[0]?.questionCount).toBe(7);
  });

  it("opens no item for one user asking across several chats", async () => {
    const topic = newTopic();
    const first = label();
    mockVerdict(unanswered(first));
    const persistent = await newUser();
    for (let index = 0; index < 5; index++) {
      await ask(await newConversation(botId, persistent), topic);
    }
    const [cluster] = await clusterFor(first);
    expect(cluster?.questionCount).toBe(5);
    expect(await itemsOf(cluster!.id)).toHaveLength(0);
  });

  it("opens no item for many questions from one chat", async () => {
    const topic = newTopic();
    const first = label();
    mockVerdict(unanswered(first));
    const chat = await newConversation();
    for (let index = 0; index < 6; index++) await ask(chat, topic);
    const [cluster] = await clusterFor(first);
    expect(cluster?.questionCount).toBe(6);
    expect(await itemsOf(cluster!.id)).toHaveLength(0);
  });

  it("a Dismissed group absorbs silently; an Answered one starts a new group", async () => {
    const dismissedTopic = newTopic();
    const dismissedLabel = label();
    mockVerdict(unanswered(dismissedLabel));
    await ask(await newConversation(), dismissedTopic);
    const [dismissed] = await clusterFor(dismissedLabel);

    const answeredTopic = newTopic();
    const answeredLabel = label();
    mockVerdict(unanswered(answeredLabel));
    await ask(await newConversation(), answeredTopic);
    const [answered] = await clusterFor(answeredLabel);

    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(docGapClusters)
        .set({ status: Dismissed })
        .where(eq(docGapClusters.id, dismissed!.id));
      await ownerDb
        .update(docGapClusters)
        .set({ status: Answered, answeredByDocumentId: "999999999" })
        .where(eq(docGapClusters.id, answered!.id));
    });

    mockVerdict(unanswered(label()));
    for (let index = 0; index < 5; index++) await ask(await newConversation(), dismissedTopic);
    const [grown] = await clusterFor(dismissedLabel);
    expect(grown?.status).toBe(Dismissed);
    expect(grown?.questionCount).toBe(6);
    expect(await itemsOf(dismissed!.id)).toHaveLength(0);

    const recurring = label();
    mockVerdict(unanswered(recurring));
    await ask(await newConversation(), answeredTopic);
    expect((await clusterFor(answeredLabel))[0]?.questionCount).toBe(1);
    const [fresh] = await clusterFor(recurring);
    expect(fresh?.status).toBe(Open);
    expect(fresh?.id).not.toBe(answered?.id);
  });
});

describe("the item follows its group", () => {
  async function groupWithItem() {
    const topic = newTopic();
    const first = label();
    mockVerdict(unanswered(first));
    await ask(await newConversation(), topic);
    mockVerdict(unanswered(label()));
    for (let index = 0; index < 4; index++) await ask(await newConversation(), topic);
    const [cluster] = await clusterFor(first);
    const [item] = await itemsOf(cluster!.id);
    expect(item?.status).toBe(Schemas.QualityIssueStatusIntEnum.Open);
    return { cluster: cluster!, item: item!, topic };
  }

  const post = async (path: string) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminA}` },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };

  it("dismissing a group dismisses its item, with an admin event", async () => {
    const { cluster, item } = await groupWithItem();
    const response = await post(`/dashboard/doc-gap-clusters/${cluster.publicId}/dismiss`);
    expect(response.status).toBe(200);
    const [closed] = await itemsOf(cluster.id);
    expect(closed?.status).toBe(Schemas.QualityIssueStatusIntEnum.Dismissed);
    const events = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, item.id),
            eq(activityLog.entityAction, Schemas.QualityIssueEntityActionEnum.Dismissed),
          ),
        );
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.Admin);
  });

  it("removing the answering document reopens the group's Fixed item, and it can close again", async () => {
    const { cluster, item } = await groupWithItem();
    const db = getDbClient(env);
    const documentId = "999999998";
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(docGapClusters)
        .set({ status: Answered, answeredByDocumentId: documentId })
        .where(eq(docGapClusters.id, cluster.id));
      await ownerDb
        .update(qualityIssues)
        .set({ status: Schemas.QualityIssueStatusIntEnum.Fixed })
        .where(eq(qualityIssues.id, item.id));
    });
    const reopened = await withTenant(db, companyA, async (tx) => {
      const groups = await new DocGapClustersDAL().reopenDocGapClustersByDocuments(tx, {
        companyId: companyA,
        knowledgeDocumentIds: [documentId],
      });
      return await DocGapQualityProvider.reopenForClusters(tx, {
        companyId: companyA,
        docGapClusterIds: groups.reopenedIds ?? [],
      });
    });
    expect(reopened.isSuccess).toBe(true);
    expect((await itemsOf(cluster.id))[0]?.status).toBe(Schemas.QualityIssueStatusIntEnum.Open);

    const dismissed = await post(`/dashboard/doc-gap-clusters/${cluster.publicId}/dismiss`);
    expect(dismissed.status).toBe(200);
    expect((await itemsOf(cluster.id))[0]?.status).toBe(
      Schemas.QualityIssueStatusIntEnum.Dismissed,
    );

    // DEV_NOTE: An item an admin dismissed stays dismissed when its group reopens
    const untouched = await withTenant(db, companyA, async (tx) => {
      return await DocGapQualityProvider.reopenForClusters(tx, {
        companyId: companyA,
        docGapClusterIds: [cluster.id],
      });
    });
    expect(untouched.isSuccess).toBe(true);
    expect((await itemsOf(cluster.id))[0]?.status).toBe(
      Schemas.QualityIssueStatusIntEnum.Dismissed,
    );
  });

  it("closing the item leaves the group alone, and the growing group opens no second item", async () => {
    const { cluster, item, topic } = await groupWithItem();
    const closed = await post(`/dashboard/quality-issues/${item.publicId}/dismiss`);
    expect(closed.status).toBe(200);
    expect((await clusterFor(cluster.label))[0]?.status).toBe(Open);

    // DEV_NOTE: The group is still Open and growing; its item stays closed and alone
    await ask(await newConversation(), topic);
    expect((await clusterFor(cluster.label))[0]?.questionCount).toBe(6);
    const items = await itemsOf(cluster.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe(Schemas.QualityIssueStatusIntEnum.Dismissed);
  });

  it("the API names the group, it can't become a test, and the daily health check doesn't touch it", async () => {
    const { cluster, item } = await groupWithItem();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://localhost/dashboard/quality-issues/${item.publicId}`, {
        headers: { Authorization: `Bearer ${adminA}` },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await response.json<Schemas.GetQualityIssueApiResponse>();
    expect(body.qualityIssue?.docGapCluster).toEqual({ label: cluster.label });
    expect(body.qualityIssue?.isChatbotWide).toBe(true);
    expect((await post(`/dashboard/quality-issues/${item.publicId}/test-draft`)).status).toBe(409);

    // DEV_NOTE: The item has no conversation, like a health issue: the check must open its own, not extend this one
    const db = getDbClient(env);
    const drop = await withTenant(db, companyA, async (tx) => {
      return await ChatbotHealthProvider.record(tx, {
        companyId: companyA,
        chatbotId: botId,
        day: "2026-10-30",
        drops: [],
      });
    });
    expect("isOpened" in drop && drop.isOpened).toBe(true);
    const [untouched] = await itemsOf(cluster.id);
    expect(untouched?.note).toBe(item.note);
  });
});

describe("closeConversation: the outcome", () => {
  const outcomeOf = async (conversationId: string) =>
    await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select({ outcome: conversations.outcome })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      return row?.outcome;
    });

  it("is Couldn't answer when the last question became a gap, Answered when a later one didn't", async () => {
    const repo = new ConversationsRepo(env);
    mockVerdict(unanswered(label()));

    const gapLast = await newConversation();
    await ask(gapLast, newTopic());
    await repo.closeConversation({
      session: session(gapLast),
      outcome: Schemas.ConversationOutcomeIntEnum.Answered,
    });
    expect(await outcomeOf(gapLast.id)).toBe(Schemas.ConversationOutcomeIntEnum.Idk);

    const answeredLater = await newConversation();
    await ask(answeredLater, newTopic());
    await recordQuestion(answeredLater, { signal: null });
    await repo.closeConversation({
      session: session(answeredLater),
      outcome: Schemas.ConversationOutcomeIntEnum.Answered,
    });
    expect(await outcomeOf(answeredLater.id)).toBe(Schemas.ConversationOutcomeIntEnum.Answered);

    // DEV_NOTE: The verdict arrives after the close
    const closedFirst = await newConversation();
    const late = await recordQuestion(closedFirst);
    await repo.closeConversation({
      session: session(closedFirst),
      outcome: Schemas.ConversationOutcomeIntEnum.Answered,
    });
    expect(await outcomeOf(closedFirst.id)).toBe(Schemas.ConversationOutcomeIntEnum.Answered);
    await deliver(late.outboxIds![0]!, newTopic());
    expect(await outcomeOf(closedFirst.id)).toBe(Schemas.ConversationOutcomeIntEnum.Idk);

    const abandoned = await newConversation();
    await ask(abandoned, newTopic());
    await repo.closeConversation({
      session: session(abandoned),
      outcome: Schemas.ConversationOutcomeIntEnum.Abandoned,
    });
    expect(await outcomeOf(abandoned.id)).toBe(Schemas.ConversationOutcomeIntEnum.Abandoned);
  });
});
