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
  chatbotConfigs,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  eventOutbox,
  feedback,
  feedbackNotes,
  feedbackThemes,
  messages,
  modelCalls,
  qualityIssues,
} from "@/db/tables";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import FeedbackNotesDAL from "@/data-access-layer/FeedbackNotesDAL";
import FeedbackThemesDAL from "@/data-access-layer/FeedbackThemesDAL";
import consumeEvents from "@/queues/EventsConsumer";
import FeedbackRepo from "@/repositories/FeedbackRepo";
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

// DEV_NOTE: The model router stand-in: each test sets the summary the rewrite answers, or a router failure
vi.mock("@/repositories/ModelRouterRepo", () => ({
  default: class {
    getModel = mocks.getModel;
  },
}));

// DEV_NOTE: M7-10 "Done when": a note's theme opens a Quality item at 5 notes from 3 users. Notes go the real way:
// FeedbackRepo stores the rating and the note and writes the event, consumeEvents handles it, all as diletta_app (RLS
// applies); fixtures and checks run as the owner. Tests hit the Neon staging branch; afterAll deletes every row this
// suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
const { Up, Down } = Schemas.FeedbackRatingIntEnum;

let companyA = "";
let companyB = "";
let botId = "";
let botPublicId = "";

// DEV_NOTE: One axis per topic, so notes on a topic are identical and topics are orthogonal (similarity 0)
let nextAxis = 0;
const newTopic = () => {
  const axis = nextAxis++;
  return Array.from({ length: 1024 }, (_, index) => (index === axis ? 1 : 0));
};

const embedEnv = (embedding: number[] | null): Env => ({
  ...env,
  AI: {
    aiGatewayLogId: "log_feedback",
    run: vi.fn(async () => {
      if (embedding === null) throw new Error("embed down");
      return { data: [embedding] };
    }),
  } as unknown as Ai,
});

function mockSummary(answer: Schemas.FeedbackNoteRewriteOutput) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(answer) }],
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

// DEV_NOTE: Letters only: a run of digits (as in a UUID) is what the personal details check refuses
const label = () =>
  `Topic ${crypto.randomUUID().replace(/[^a-f]/g, "")}${nextAxis}x`.replace(/\d/g, "q");
const specific = (summaryGeneric: string) => ({ isSpecific: true, summaryGeneric });

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// DEV_NOTE: A user, their open conversation and one synced reply to rate: what the widget's session would name
async function newReply() {
  return await withOwnerDb(async (ownerDb) => {
    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    const [conversation] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        chatbotUserId: user!.id,
        chatbotId: botId,
      })
      .returning({ id: conversations.id, publicId: conversations.publicId });
    const sessionMessageId = `a_${crypto.randomUUID()}`;
    await ownerDb.insert(messages).values({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      conversationId: conversation!.id,
      sessionMessageId,
      turnId: Utility.generateUlid(),
      role: Schemas.MessageRoleIntEnum.Assistant,
      content: { text: "Run fire drills every 6 months." },
    });
    const session: Schemas.ConversationSession = {
      companyId: companyA,
      chatbotId: botId,
      chatbotPublicId: botPublicId,
      chatbotName: "Support",
      chatbotUserId: user!.id,
      conversationId: conversation!.id,
      conversationPublicId: conversation!.publicId,
      eval: null,
    };
    return { session, sessionMessageId };
  });
}

type Reply = Awaited<ReturnType<typeof newReply>>;

async function rate(reply: Reply, rating: Schemas.FeedbackRatingIntEnum) {
  const rated = await new FeedbackRepo(env).recordFeedback({ ...reply, rating });
  expect(rated.isSuccess).toBe(true);
}

// DEV_NOTE: The note through the Repo; answers its event's outbox id
async function note(reply: Reply, text: string) {
  const noted = await new FeedbackRepo(env).recordFeedbackNote({ ...reply, note: text });
  expect(noted.isSuccess).toBe(true);
  expect(noted.outboxId).toBeDefined();
  return noted.outboxId!;
}

const eventsOf = async (outboxIds: string[]) =>
  await withOwnerDb(async (ownerDb) => {
    return await ownerDb.select().from(eventOutbox).where(inArray(eventOutbox.id, outboxIds));
  });

// DEV_NOTE: Hands the event to the consumer as the queue would; answers the message so a test can read ack / retry
async function deliver(outboxId: string, embedding: number[] | null) {
  const [row] = await eventsOf([outboxId]);
  const delivered = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body: {
      outboxId: row!.id,
      companyId: row!.companyId,
      activityLogId: row!.activityLogId,
      eventType: row!.eventType,
      dedupeKey: row!.dedupeKey,
    },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
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

// DEV_NOTE: A rated reply with a note, read and grouped
async function notedReply(
  rating: Schemas.FeedbackRatingIntEnum,
  summary: string,
  embedding: number[],
  reply?: Reply,
) {
  const rated = reply ?? (await newReply());
  await rate(rated, rating);
  mockSummary(specific(summary));
  const delivered = await deliver(await note(rated, "Some note"), embedding);
  expect(delivered.ack).toHaveBeenCalled();
  return rated;
}

const themesLabelled = async (themeLabel: string) =>
  await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(feedbackThemes.companyId, companyA),
      eq(feedbackThemes.label, themeLabel),
    ];
    return await ownerDb
      .select()
      .from(feedbackThemes)
      .where(and(...conditions));
  });

const noteOf = async (reply: Reply) =>
  await withOwnerDb(async (ownerDb) => {
    const rows = await ownerDb
      .select({ note: feedbackNotes })
      .from(feedbackNotes)
      .innerJoin(feedback, eq(feedback.id, feedbackNotes.feedbackId))
      .innerJoin(messages, eq(messages.id, feedback.messageId))
      .where(eq(messages.sessionMessageId, reply.sessionMessageId));
    return rows[0]?.note ?? null;
  });

const itemsOf = async (themeId: string) =>
  await withOwnerDb(async (ownerDb) => {
    return await ownerDb
      .select()
      .from(qualityIssues)
      .where(eq(qualityIssues.feedbackThemeId, themeId));
  });

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Themes A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Themes B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    const [bot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" })
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    botId = bot!.id;
    botPublicId = bot!.publicId;

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
    await ownerDb.insert(chatbotConfigs).values({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotId: botId,
      configVersion: 1,
      schemaVersion: normalized.schemaVersion,
      status: Schemas.ChatbotConfigStatusIntEnum.Published,
      body: normalized.body,
      bodyHash: "themes-0",
      publishedAt: new Date(),
    });
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
    await ownerDb.delete(feedbackNotes).where(inArray(feedbackNotes.companyId, companyIds));
    await ownerDb.delete(feedbackThemes).where(inArray(feedbackThemes.companyId, companyIds));
    await ownerDb.delete(feedback).where(inArray(feedback.companyId, companyIds));
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("a stored note's event", () => {
  it("carries ids and the note's version only, one per version", async () => {
    const reply = await newReply();
    await rate(reply, Down);
    const first = await note(reply, "Priya Shah here: policy 88213 is quarterly now");
    const second = await note(reply, "Priya again: still wrong");
    expect(first).not.toBe(second);

    const events = await eventsOf([first, second]);
    expect(events.map((event) => event.eventType)).toEqual([
      Schemas.FEEDBACK_NOTE_ADDED_EVENT_TYPE,
      Schemas.FEEDBACK_NOTE_ADDED_EVENT_TYPE,
    ]);
    const logs = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .select()
        .from(activityLog)
        .where(
          inArray(
            activityLog.id,
            events.map((event) => event.activityLogId),
          ),
        );
    });
    for (const log of logs) {
      expect(JSON.stringify(log.detail)).not.toContain("Priya");
      expect(Schemas.ZFeedbackNoteAddedDetail.safeParse(log.detail).success).toBe(true);
    }
    expect(
      logs.map((log) => (log.detail as Schemas.FeedbackNoteAddedDetail).commentVersion).sort(),
    ).toEqual([1, 2]);
  });
});

describe("consumer: a note becomes a theme", () => {
  it("summarises on the small tier as a background call, and one note opens no Quality item", async () => {
    const summary = label();
    const reply = await newReply();
    await rate(reply, Down);
    const prompts = mockSummary(specific(summary));
    const delivered = await deliver(await note(reply, "Our policy is quarterly now"), newTopic());

    expect(delivered.ack).toHaveBeenCalled();
    expect(delivered.retry).not.toHaveBeenCalled();
    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: companyA,
        chatbotId: botId,
        conversationId: null,
        chatbotUserId: null,
        taskType: Schemas.ModelTaskTypeEnum.FeedbackNoteRewrite,
        tier: Schemas.ModelTierEnum.Small,
      }),
    );
    expect(prompts[0]).toContain("Our policy is quarterly now");
    expect(prompts[0]).toContain("not helpful");

    const [theme] = await themesLabelled(summary);
    expect(theme?.rating).toBe(Down);
    expect(theme?.noteCount).toBe(1);
    expect(theme?.status).toBe(Schemas.FeedbackThemeStatusIntEnum.Open);
    const stored = await noteOf(reply);
    expect(stored?.themeId).toBe(theme?.id);
    expect(stored?.summary).toBe(summary);
    expect(await itemsOf(theme!.id)).toEqual([]);

    const embedCalls = await withOwnerDb(async (ownerDb) => {
      const conditions = [
        eq(modelCalls.companyId, companyA),
        eq(modelCalls.taskType, Schemas.ModelTaskTypeEnum.FeedbackNoteEmbed),
      ];
      return await ownerDb
        .select()
        .from(modelCalls)
        .where(and(...conditions));
    });
    expect(embedCalls.length).toBeGreaterThanOrEqual(1);
    expect(embedCalls.every((call) => call.conversationId === null)).toBe(true);
  });

  it("opens one Quality item at 5 Didn't like notes from 3 users, and never for Liked notes", async () => {
    const summary = label();
    const topic = newTopic();
    const first = await newReply();
    const second = await newReply();
    const replies = [first, first, second, second, await newReply()];
    // DEV_NOTE: A user rates two replies of their conversation: the second reply is a new message of the same chat
    const sameUserReply = async (reply: Reply) => {
      const sessionMessageId = `a_${crypto.randomUUID()}`;
      await withOwnerDb(async (ownerDb) => {
        await ownerDb.insert(messages).values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId: reply.session.conversationId,
          sessionMessageId,
          turnId: Utility.generateUlid(),
          role: Schemas.MessageRoleIntEnum.Assistant,
          content: { text: "Every 6 months." },
        });
      });
      return { ...reply, sessionMessageId };
    };

    const seen = new Set<string>();
    for (const [index, owner] of replies.entries()) {
      const reply = seen.has(owner.sessionMessageId) ? await sameUserReply(owner) : owner;
      seen.add(owner.sessionMessageId);
      await notedReply(Down, summary, topic, reply);
      const [theme] = await themesLabelled(summary);
      expect(theme?.noteCount).toBe(index + 1);
      expect(await itemsOf(theme!.id)).toHaveLength(index === replies.length - 1 ? 1 : 0);
    }
    const [theme] = await themesLabelled(summary);
    const [item] = await itemsOf(theme!.id);
    expect(item?.source).toBe(Schemas.QualityIssueSourceIntEnum.System);
    expect(item?.issueType).toBe(Schemas.QualityIssueTypeIntEnum.FeedbackTheme);
    expect(item?.conversationId).toBeNull();
    expect(item?.chatbotId).toBe(botId);
    expect(item?.note).toBe(Schemas.feedbackThemeQualityNote(summary));

    const liked = label();
    const likedTopic = newTopic();
    for (let index = 0; index < 5; index++) await notedReply(Up, liked, likedTopic);
    const [likedTheme] = await themesLabelled(liked);
    expect(likedTheme?.noteCount).toBe(5);
    expect(likedTheme?.rating).toBe(Up);
    expect(await itemsOf(likedTheme!.id)).toEqual([]);
  });

  it("keeps thumbs apart: the same topic Liked and Didn't like makes two themes", async () => {
    const topic = newTopic();
    const down = label();
    await notedReply(Down, down, topic);
    mocks.getModel.mockReset();
    const up = label();
    await notedReply(Up, up, topic);
    expect((await themesLabelled(down))[0]?.rating).toBe(Down);
    expect((await themesLabelled(up))[0]?.rating).toBe(Up);
  });
});

describe("consumer: edits, thumb switches and notes it drops", () => {
  it("drops an event whose note was edited since, and moves the edited note to its new theme", async () => {
    const reply = await newReply();
    await rate(reply, Down);
    const firstSummary = label();
    const firstTopic = newTopic();
    mockSummary(specific(firstSummary));
    const firstEvent = await note(reply, "First note");
    expect((await deliver(firstEvent, firstTopic)).ack).toHaveBeenCalled();
    const [firstTheme] = await themesLabelled(firstSummary);
    expect(firstTheme?.noteCount).toBe(1);

    const editEvent = await note(reply, "Edited note");
    mocks.getModel.mockReset();
    const stale = await deliver(firstEvent, firstTopic);
    expect(stale.ack).toHaveBeenCalled();
    expect(mocks.getModel).not.toHaveBeenCalled();

    const editSummary = label();
    mockSummary(specific(editSummary));
    expect((await deliver(editEvent, newTopic())).ack).toHaveBeenCalled();
    expect((await themesLabelled(firstSummary))[0]?.noteCount).toBe(0);
    const [editTheme] = await themesLabelled(editSummary);
    expect(editTheme?.noteCount).toBe(1);
    expect((await noteOf(reply))?.themeId).toBe(editTheme?.id);

    // DEV_NOTE: A redelivery of the event already handled writes nothing
    mocks.getModel.mockReset();
    expect((await deliver(editEvent, newTopic())).ack).toHaveBeenCalled();
    expect(mocks.getModel).not.toHaveBeenCalled();
    expect((await themesLabelled(editSummary))[0]?.noteCount).toBe(1);
  });

  it("takes the note out of its theme when the user switches thumbs", async () => {
    const summary = label();
    const reply = await notedReply(Down, summary, newTopic());
    expect((await themesLabelled(summary))[0]?.noteCount).toBe(1);
    await rate(reply, Up);
    expect(await noteOf(reply)).toBeNull();
    expect((await themesLabelled(summary))[0]?.noteCount).toBe(0);
  });

  it("stores nothing for a note that says nothing specific, or one the rewrite kept personal details in", async () => {
    for (const answer of [
      { isSpecific: false, summaryGeneric: "" },
      { isSpecific: true, summaryGeneric: "Call me on 0412345678" },
    ]) {
      const reply = await newReply();
      await rate(reply, Down);
      mockSummary(answer);
      const delivered = await deliver(await note(reply, "thanks"), newTopic());
      expect(delivered.ack).toHaveBeenCalled();
      expect(await noteOf(reply)).toBeNull();
    }
  });

  it("retries when the model or the embedding fails, and drops on a spent budget", async () => {
    const reply = await newReply();
    await rate(reply, Down);
    const event = await note(reply, "Too slow");

    mocks.getModel.mockResolvedValue({
      isSuccess: false,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
    });
    const providerDown = await deliver(event, newTopic());
    expect(providerDown.retry).toHaveBeenCalled();

    const summary = label();
    mockSummary(specific(summary));
    const embedDown = await deliver(event, null);
    expect(embedDown.retry).toHaveBeenCalled();
    // DEV_NOTE: The summary was kept: the next try embeds it without paying for the rewrite again
    expect((await noteOf(reply))?.themeId).toBeNull();
    mocks.getModel.mockReset();
    expect((await deliver(event, newTopic())).ack).toHaveBeenCalled();
    expect(mocks.getModel).not.toHaveBeenCalled();
    expect((await themesLabelled(summary))[0]?.noteCount).toBe(1);

    const spent = await newReply();
    await rate(spent, Down);
    mocks.getModel.mockResolvedValue({
      isSuccess: false,
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    const dropped = await deliver(await note(spent, "Too long"), newTopic());
    expect(dropped.ack).toHaveBeenCalled();
    expect(await noteOf(spent)).toBeNull();
  });
});

describe("tenancy (as diletta_app)", () => {
  it("never reads another company's notes or themes", async () => {
    const summary = label();
    const topic = newTopic();
    const reply = await notedReply(Down, summary, topic);
    const stored = await noteOf(reply);
    if (!stored) throw new Error("Note not stored");

    const db = getDbClient(env);
    const read = await withTenant(db, companyB, async (tx) => {
      const source = await new FeedbackNotesDAL().getFeedbackNoteSource(tx, {
        companyId: companyB,
        feedbackId: stored.feedbackId,
      });
      const byFeedback = await new FeedbackNotesDAL().getFeedbackNoteByFeedback(tx, {
        companyId: companyB,
        feedbackId: stored.feedbackId,
      });
      const nearest = await new FeedbackThemesDAL().findNearestFeedbackTheme(tx, {
        companyId: companyB,
        chatbotId: botId,
        rating: Down,
        embedding: topic,
      });
      return { isSuccess: true, source, byFeedback, nearest };
    });
    if (!("source" in read)) throw new Error("Reads failed");
    expect(read.source.isNotFound).toBe(true);
    expect(read.byFeedback.feedbackNote).toBeUndefined();
    expect(read.nearest.feedbackTheme).toBeUndefined();
  });
});
