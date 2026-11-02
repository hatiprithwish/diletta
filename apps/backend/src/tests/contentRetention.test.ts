import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { getAgentByName } from "agents";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  admins,
  changeRequests,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  docGaps,
  evalCases,
  evalResults,
  evalRuns,
  feedback,
  files,
  messages,
  modelCalls,
  qualityIssues,
  toolCalls,
} from "@/db/tables";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import FeedbackDAL from "@/data-access-layer/FeedbackDAL";
import AppLogger from "@/providers/logger";
import FileStorageProvider from "@/providers/fileStorage";
import ContentRetentionRepo from "@/repositories/ContentRetentionRepo";
import ConversationsRepo from "@/repositories/ConversationsRepo";
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

// DEV_NOTE: M6-1 "Done when": a purged chat leaves only counts and gap text. The Repo runs as diletta_app (HYPERDRIVE),
// limited to this suite's companies so it never touches other rows on the shared staging branch; fixtures and checks run
// as the owner. These chats' DOs were never connected, so their wipe is a no-op success; the wipe itself is covered in
// actionConversation.test.ts. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const BYTES = Buffer.from([1, 2, 3]);
const GAP_TEXT = "How do I change my billing address?";

let shortCompany = ""; // 7 days
let defaultCompany = ""; // empty: 30 days
let companyPublicId = "";
let adminId = "";
let expired = ""; // short, 8 days idle, Open, every kind of content
let fresh = ""; // short, 6 days idle
let underDefault = ""; // default, 20 days idle
let pastDefault = ""; // default, 40 days idle
let evalChat = ""; // short, 8 days idle, an eval attempt with a transcript
let transcriptFilePublicId = "";
let evalRunId = "";
let evalCaseId = "";
let shortChat = { companyId: "", chatbotId: "", chatbotUserId: "" };
let shortHostUserId = "";
const transcriptFileIds: string[] = [];
const conversationIds: Record<string, string> = {};

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

const row = (publicId: string) =>
  withOwnerDb(async (ownerDb) => {
    const [conversation] = await ownerDb
      .select()
      .from(conversations)
      .where(eq(conversations.publicId, publicId));
    return conversation!;
  });

// DEV_NOTE: One chat with a message of each role, a tool call, a change request waiting for a person, a rated reply
// with a comment, and a doc gap on its question
async function seedChat(
  ownerDb: NodePgDatabase,
  params: {
    companyId: string;
    chatbotId: string;
    chatbotUserId: string;
    idleDays: number;
    eval?: { evalRunId: string; evalCaseId: string; evalAttempt: number };
  },
): Promise<string> {
  const publicId = Utility.generatePublicId();
  const { companyId } = params;
  const [conversation] = await ownerDb
    .insert(conversations)
    .values({
      publicId,
      companyId,
      chatbotId: params.chatbotId,
      chatbotUserId: params.chatbotUserId,
      title: "My address is 12 Elm Street",
      lastActivityAt: daysAgo(params.idleDays),
      ...params.eval,
    })
    .returning({ id: conversations.id });
  const conversationId = conversation!.id;
  conversationIds[publicId] = conversationId;
  const turnId = Utility.generateUlid(Date.now());
  const inserted = await ownerDb
    .insert(messages)
    .values([
      {
        publicId: Utility.generatePublicId(),
        companyId,
        conversationId,
        sessionMessageId: "m1",
        turnId,
        role: Schemas.MessageRoleIntEnum.User,
        content: { text: "My address is 12 Elm Street" },
      },
      {
        publicId: Utility.generatePublicId(),
        companyId,
        conversationId,
        sessionMessageId: "m2",
        turnId,
        role: Schemas.MessageRoleIntEnum.Assistant,
        content: { text: "Thanks" },
      },
    ])
    .returning({ id: messages.id });
  const [call] = await ownerDb
    .insert(toolCalls)
    .values({
      publicId: Utility.generatePublicId(),
      companyId,
      conversationId,
      turnId,
      toolId: "1",
      toolVersion: 1,
      encryptedArgs: BYTES,
      iv: BYTES,
      encryptionKeyVersion: 1,
      status: Schemas.ToolCallStatusIntEnum.Ok,
    })
    .returning({ id: toolCalls.id });
  await ownerDb.insert(changeRequests).values({
    publicId: Utility.generatePublicId(),
    companyId,
    conversationId,
    toolCallId: call!.id,
    status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
    encryptedChanges: BYTES,
    iv: BYTES,
    encryptionKeyVersion: 1,
    summary: "Update 1 record",
    changeCount: 1,
  });
  await ownerDb.insert(feedback).values({
    publicId: Utility.generatePublicId(),
    companyId,
    messageId: inserted[1]!.id,
    chatbotUserId: params.chatbotUserId,
    rating: Schemas.FeedbackRatingIntEnum.Down,
    comment: "It got 12 Elm Street wrong",
  });
  await ownerDb.insert(docGaps).values({
    publicId: Utility.generatePublicId(),
    companyId,
    chatbotId: params.chatbotId,
    conversationId,
    messageId: inserted[0]!.id,
    questionGeneric: GAP_TEXT,
    signal: Schemas.DocGapSignalIntEnum.Idk,
  });
  await ownerDb.insert(modelCalls).values({
    publicId: Utility.generatePublicId(),
    companyId,
    chatbotId: params.chatbotId,
    chatbotUserId: params.chatbotUserId,
    conversationId,
    turnId,
    taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
    tier: Schemas.ModelCallTierIntEnum.Small,
    provider: Schemas.ModelProviderEnum.Anthropic,
    model: "claude-sonnet-5-5",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: "0.010000",
  });
  await ownerDb.insert(qualityIssues).values({
    publicId: Utility.generatePublicId(),
    companyId,
    chatbotId: params.chatbotId,
    conversationId,
    source: Schemas.QualityIssueSourceIntEnum.Admin,
    createdBy: adminId,
    note: "Triage note",
  });
  return publicId;
}

// DEV_NOTE: An eval attempt's transcript: its files row, result and R2 object
async function seedTranscript(ownerDb: NodePgDatabase, attempt: number): Promise<string> {
  const filePublicId = Utility.generatePublicId();
  const [file] = await ownerDb
    .insert(files)
    .values({
      publicId: filePublicId,
      companyId: shortCompany,
      ownerType: Schemas.FileOwnerTypeEnum.EvalResult,
      ownerId: Schemas.FILE_PENDING_OWNER_ID,
      mime: Schemas.EVAL_TRANSCRIPT_MIME,
      sizeBytes: 2,
      sha256: "test",
    })
    .returning({ id: files.id });
  const [result] = await ownerDb
    .insert(evalResults)
    .values({
      companyId: shortCompany,
      evalRunId,
      evalCaseId,
      attempt,
      hasPassed: true,
      transcriptFileId: file!.id,
    })
    .returning({ id: evalResults.id });
  await ownerDb.update(files).set({ ownerId: result!.id }).where(eq(files.id, file!.id));
  await env.FILES_BUCKET.put(Schemas.fileR2Key(companyPublicId, filePublicId), "{}");
  transcriptFileIds.push(filePublicId);
  return filePublicId;
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        {
          publicId: Utility.generatePublicId(),
          name: `Retention A ${crypto.randomUUID()}`,
          contentRetentionDays: 7,
        },
        { publicId: Utility.generatePublicId(), name: `Retention B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id, publicId: companies.publicId });
    shortCompany = created[0]!.id;
    companyPublicId = created[0]!.publicId;
    defaultCompany = created[1]!.id;
    const adminRows = await ownerDb
      .insert(admins)
      .values({ clerkUserId: `user_ret_${crypto.randomUUID()}`, companyId: shortCompany })
      .returning({ id: admins.id });
    adminId = adminRows[0]!.id;

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: shortCompany, name: "Short" },
        { publicId: Utility.generatePublicId(), companyId: defaultCompany, name: "Default" },
      ])
      .returning({ id: chatbots.id });
    shortHostUserId = `u-${crypto.randomUUID()}`;
    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        { companyId: shortCompany, hostUserId: shortHostUserId },
        { companyId: defaultCompany, hostUserId: `u-${crypto.randomUUID()}` },
      ])
      .returning({ id: chatbotUsers.id });
    const short = { companyId: shortCompany, chatbotId: bots[0]!.id, chatbotUserId: users[0]!.id };
    shortChat = short;
    const byDefault = {
      companyId: defaultCompany,
      chatbotId: bots[1]!.id,
      chatbotUserId: users[1]!.id,
    };

    expired = await seedChat(ownerDb, { ...short, idleDays: 8 });
    fresh = await seedChat(ownerDb, { ...short, idleDays: 6 });
    underDefault = await seedChat(ownerDb, { ...byDefault, idleDays: 20 });
    pastDefault = await seedChat(ownerDb, { ...byDefault, idleDays: 40 });

    const [run] = await ownerDb
      .insert(evalRuns)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: shortCompany,
        chatbotConfigId: "1",
        trigger: Schemas.EvalRunTriggerIntEnum.Manual,
        harnessVersion: "test",
        k: 1,
      })
      .returning({ id: evalRuns.id });
    evalRunId = run!.id;
    const [evalCase] = await ownerDb
      .insert(evalCases)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: shortCompany,
        chatbotId: short.chatbotId,
        name: "Case",
        input: {},
        expectations: {},
      })
      .returning({ id: evalCases.id });
    evalCaseId = evalCase!.id;
    evalChat = await seedChat(ownerDb, {
      ...short,
      idleDays: 8,
      eval: { evalRunId, evalCaseId, evalAttempt: 1 },
    });
    transcriptFilePublicId = await seedTranscript(ownerDb, 1);
  });
});

afterAll(async () => {
  await Promise.all(
    transcriptFileIds.map((publicId) =>
      env.FILES_BUCKET.delete(Schemas.fileR2Key(companyPublicId, publicId)),
    ),
  );
  await withOwnerDb(async (ownerDb) => {
    const companyIds = [shortCompany, defaultCompany];
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(docGaps).where(inArray(docGaps.companyId, companyIds));
    await ownerDb.delete(feedback).where(inArray(feedback.companyId, companyIds));
    await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
    await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(evalResults).where(inArray(evalResults.companyId, companyIds));
    await ownerDb.delete(files).where(inArray(files.companyId, companyIds));
    await ownerDb.delete(evalCases).where(inArray(evalCases.companyId, companyIds));
    await ownerDb.delete(evalRuns).where(inArray(evalRuns.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("Retention purge (M6-1)", () => {
  it("purges each chat on its own company's clock, every other chat untouched", async () => {
    const purged = await new ContentRetentionRepo(env).purgeExpiredContent({
      companyIds: [shortCompany, defaultCompany],
    });
    expect(purged).toMatchObject({ isSuccess: true, purgedCount: 3, skippedCount: 0 });

    expect((await row(expired)).contentPurgedAt).not.toBeNull();
    expect((await row(pastDefault)).contentPurgedAt).not.toBeNull();
    expect((await row(evalChat)).contentPurgedAt).not.toBeNull();
    for (const untouched of [fresh, underDefault]) {
      const conversation = await row(untouched);
      expect(conversation.contentPurgedAt).toBeNull();
      expect(conversation.title).not.toBeNull();
      expect(conversation.status).toBe(Schemas.ConversationStatusIntEnum.Open);
    }
  });

  it("leaves a purged chat only counts and gap text", async () => {
    const conversation = await row(expired);
    expect(conversation.title).toBeNull();
    expect(conversation.status).toBe(Schemas.ConversationStatusIntEnum.Closed);
    // DEV_NOTE: It has a reply, and a doc gap on its last question
    expect(conversation.outcome).toBe(Schemas.ConversationOutcomeIntEnum.Idk);
    const conversationId = conversation.id;

    await withOwnerDb(async (ownerDb) => {
      const chatMessages = await ownerDb
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      expect(chatMessages).toHaveLength(2);
      expect(chatMessages.every((message) => message.content === null)).toBe(true);

      const [call] = await ownerDb
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.conversationId, conversationId));
      expect(call).toMatchObject({ encryptedArgs: null, iv: null, encryptionKeyVersion: null });

      // DEV_NOTE: Retention is the backstop for a change nobody resolved: the values go, the status stays
      const [change] = await ownerDb
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.conversationId, conversationId));
      expect(change).toMatchObject({
        encryptedChanges: null,
        iv: null,
        encryptionKeyVersion: null,
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        summary: "Update 1 record",
        changeCount: 1,
      });

      const [rating] = await ownerDb
        .select()
        .from(feedback)
        .where(eq(feedback.messageId, chatMessages[1]!.id));
      expect(rating).toMatchObject({ comment: null, rating: Schemas.FeedbackRatingIntEnum.Down });

      const gaps = await ownerDb
        .select({ conversationId: docGaps.conversationId, messageId: docGaps.messageId })
        .from(docGaps)
        .where(
          inArray(
            docGaps.messageId,
            chatMessages.map((message) => message.id),
          ),
        );
      expect(gaps).toEqual([]);
      const texts = await ownerDb
        .select({
          conversationId: docGaps.conversationId,
          messageId: docGaps.messageId,
          questionGeneric: docGaps.questionGeneric,
        })
        .from(docGaps)
        .where(eq(docGaps.companyId, shortCompany));
      expect(texts.filter((gap) => gap.conversationId === null)).toEqual([
        { conversationId: null, messageId: null, questionGeneric: GAP_TEXT },
        { conversationId: null, messageId: null, questionGeneric: GAP_TEXT },
      ]);

      const [spend] = await ownerDb
        .select({ costUsd: modelCalls.costUsd })
        .from(modelCalls)
        .where(eq(modelCalls.conversationId, conversationId));
      expect(spend!.costUsd).toBe("0.010000");

      // DEV_NOTE: The admin's own triage record stays (runbook: known exception)
      const [issue] = await ownerDb
        .select({ note: qualityIssues.note })
        .from(qualityIssues)
        .where(eq(qualityIssues.conversationId, conversationId));
      expect(issue!.note).toBe("Triage note");
    });
  });

  it("removes an eval attempt's transcript, row and object, and keeps its grade", async () => {
    expect(
      await env.FILES_BUCKET.head(Schemas.fileR2Key(companyPublicId, transcriptFilePublicId)),
    ).toBeNull();
    await withOwnerDb(async (ownerDb) => {
      expect(
        await ownerDb.select().from(files).where(eq(files.publicId, transcriptFilePublicId)),
      ).toEqual([]);
      const [result] = await ownerDb
        .select({ hasPassed: evalResults.hasPassed })
        .from(evalResults)
        .where(eq(evalResults.evalRunId, evalRunId));
      expect(result!.hasPassed).toBe(true);
    });
  });

  it("clears nothing twice: a second run finds no chat due", async () => {
    const purged = await new ContentRetentionRepo(env).purgeExpiredContent({
      companyIds: [shortCompany, defaultCompany],
    });
    expect(purged).toMatchObject({ isSuccess: true, purgedCount: 0, skippedCount: 0 });
  });

  it("stays inside the companies it is given", async () => {
    const purged = await new ContentRetentionRepo(env).purgeExpiredContent({
      companyIds: [shortCompany],
      now: Date.now() + 2 * DAY_MS,
    });
    expect(purged.isSuccess).toBe(true);
    expect((await row(fresh)).contentPurgedAt).not.toBeNull();
    expect((await row(underDefault)).contentPurgedAt).toBeNull();
  });
});

// DEV_NOTE: The paths the order of the steps exists for. Each test seeds its own chats on the short company and leaves
// nothing due. A step made to fail is a spy on that step; the DO answering busy is a real DO with its flag set.
describe("Retention purge retries (M6-1)", () => {
  const purge = (extra: { batchSize?: number; timeBudgetMs?: number; now?: number } = {}) =>
    new ContentRetentionRepo(env).purgeExpiredContent({ companyIds: [shortCompany], ...extra });
  const seed = (idleDays = 8) =>
    withOwnerDb((ownerDb) => seedChat(ownerDb, { ...shortChat, idleDays }));
  const contents = (publicId: string) =>
    withOwnerDb((ownerDb) =>
      ownerDb
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationIds[publicId]!)),
    );

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(AppLogger.error).mockClear();
  });

  it("leaves a chat that got a new message after the read: still Open, nothing cleared", async () => {
    const chat = await seed();
    const close = ConversationsDAL.prototype.closeConversationPastRetention;
    vi.spyOn(ConversationsDAL.prototype, "closeConversationPastRetention").mockImplementation(
      async function (this: ConversationsDAL, tx, params) {
        await withOwnerDb((ownerDb) =>
          ownerDb
            .update(conversations)
            .set({ lastActivityAt: new Date() })
            .where(eq(conversations.publicId, chat)),
        );
        return await close.call(this, tx, params);
      },
    );

    expect(await purge()).toMatchObject({ purgedCount: 0, skippedCount: 1 });
    const conversation = await row(chat);
    expect(conversation.contentPurgedAt).toBeNull();
    expect(conversation.status).toBe(Schemas.ConversationStatusIntEnum.Open);
    expect(conversation.title).not.toBeNull();

    // DEV_NOTE: No longer due: nothing to retry until it goes quiet again
    vi.restoreAllMocks();
    expect(await purge()).toMatchObject({ purgedCount: 0, skippedCount: 0 });
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(conversations)
        .set({ lastActivityAt: daysAgo(8) })
        .where(eq(conversations.publicId, chat)),
    );
    expect(await purge()).toMatchObject({ purgedCount: 1, skippedCount: 0 });
  });

  it.each(["isDeciding", "isClosing"])("leaves a chat whose DO is busy (%s)", async (flag) => {
    const chat = await seed();
    const stub = await getAgentByName(env.CONVERSATION_DO, chat);
    const setFlag = (value: boolean) =>
      runInDurableObject(stub, (instance) => {
        (instance as unknown as Record<string, boolean>)[flag] = value;
      });
    await setFlag(true);

    expect(await purge()).toMatchObject({ purgedCount: 0, skippedCount: 1 });
    expect((await row(chat)).contentPurgedAt).toBeNull();
    expect((await contents(chat)).every((message) => message.content !== null)).toBe(true);

    await setFlag(false);
    expect(await purge()).toMatchObject({ purgedCount: 1, skippedCount: 0 });
  });

  it("wipes a DO whose state no longer parses, instead of reporting a wipe it didn't do", async () => {
    const chat = await seed();
    const stub = await getAgentByName(env.CONVERSATION_DO, chat);
    await runInDurableObject(stub, async (instance) => {
      await instance.__unsafe_ensureInitialized();
      instance.configure({ notTheShape: true } as never);
    });

    // DEV_NOTE: destroy() aborts the isolate, which may reach the Repo as an error; the next run then finishes
    let purgedCount = 0;
    for (let run = 0; run < 5 && purgedCount === 0; run += 1) {
      purgedCount = (await purge()).purgedCount ?? 0;
    }
    expect(purgedCount).toBe(1);
    const fresh = await getAgentByName(env.CONVERSATION_DO, chat);
    const isStateGone = await runInDurableObject(fresh, (instance) => {
      try {
        return instance.getConfig() === null;
      } catch {
        return true;
      }
    });
    expect(isStateGone).toBe(true);
  });

  it("leaves no storage behind in a DO that never had a chat, and answers the same when asked again", async () => {
    const chat = await seed();
    const stub = await getAgentByName(env.CONVERSATION_DO, chat);
    const isBusyFree = Schemas.ZConversationContentWipeResponse.parse(
      JSON.parse(await stub.purgeContent()),
    );
    expect(isBusyFree).toMatchObject({ isSuccess: true, isBusy: false });
    const tables = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'",
          )
          .toArray().length,
    );
    expect(tables).toBe(0);
    expect(JSON.parse(await stub.purgeContent())).toMatchObject({ isSuccess: true });
    expect(await purge()).toMatchObject({ purgedCount: 1, skippedCount: 0 });
  });

  it("keeps the transcript rows and every table when R2 fails, and finishes next run", async () => {
    let chat = "";
    let filePublicId = "";
    await withOwnerDb(async (ownerDb) => {
      chat = await seedChat(ownerDb, {
        ...shortChat,
        idleDays: 8,
        eval: { evalRunId, evalCaseId, evalAttempt: 2 },
      });
      filePublicId = await seedTranscript(ownerDb, 2);
    });
    vi.spyOn(FileStorageProvider, "deleteObjects").mockResolvedValueOnce({
      isSuccess: false,
      message: "R2 down",
    });

    expect(await purge()).toMatchObject({ purgedCount: 0, skippedCount: 1 });
    expect((await row(chat)).contentPurgedAt).toBeNull();
    expect((await contents(chat)).every((message) => message.content !== null)).toBe(true);
    await withOwnerDb(async (ownerDb) => {
      expect(
        await ownerDb.select().from(files).where(eq(files.publicId, filePublicId)),
      ).toHaveLength(1);
    });

    expect(await purge()).toMatchObject({ purgedCount: 1, skippedCount: 0 });
    expect(
      await env.FILES_BUCKET.head(Schemas.fileR2Key(companyPublicId, filePublicId)),
    ).toBeNull();
  });

  it("rolls every table back when a clear step fails, and finishes next run", async () => {
    const chat = await seed();
    vi.spyOn(FeedbackDAL.prototype, "clearConversationComments").mockResolvedValueOnce({
      isSuccess: false,
      message: "Clear failed",
    });

    expect(await purge()).toMatchObject({ purgedCount: 0, skippedCount: 1 });
    const conversation = await row(chat);
    expect(conversation.contentPurgedAt).toBeNull();
    expect(conversation.title).not.toBeNull();
    // DEV_NOTE: Messages clear before the step that failed, so this is the rollback
    expect((await contents(chat)).every((message) => message.content !== null)).toBe(true);

    expect(await purge()).toMatchObject({ purgedCount: 1, skippedCount: 0 });
    expect((await contents(chat)).every((message) => message.content === null)).toBe(true);
  });

  it("doesn't let failing chats use up the run: the next run reaches the chat after them", async () => {
    const stuck = await seed(12);
    const next = await seed(9);
    const close = ConversationsDAL.prototype.closeConversationPastRetention;
    vi.spyOn(ConversationsDAL.prototype, "closeConversationPastRetention").mockImplementation(
      async function (this: ConversationsDAL, tx, params) {
        if (params.publicId === stuck) return { isSuccess: false, message: "Keeps failing" };
        return await close.call(this, tx, params);
      },
    );
    const oneChat = { batchSize: 1, timeBudgetMs: 0 };

    expect(await purge(oneChat)).toMatchObject({ purgedCount: 0, skippedCount: 1 });
    expect((await row(next)).contentPurgedAt).toBeNull();
    expect(await purge(oneChat)).toMatchObject({ purgedCount: 1, skippedCount: 0 });
    expect((await row(next)).contentPurgedAt).not.toBeNull();
    expect((await row(stuck)).contentPurgedAt).toBeNull();

    vi.restoreAllMocks();
    expect(await purge(oneChat)).toMatchObject({ purgedCount: 1, skippedCount: 0 });
  });

  it("tries a chat once per run and keeps going past a full batch", async () => {
    await seed();
    await seed();
    await seed();
    expect(await purge({ batchSize: 2 })).toMatchObject({ purgedCount: 3, skippedCount: 0 });
  });

  it("alerts when a chat left due is over a day past its cut-off, not before", async () => {
    const recent = await seed(7.5);
    vi.spyOn(ConversationsDAL.prototype, "closeConversationPastRetention").mockResolvedValue({
      isSuccess: false,
      message: "Keeps failing",
    });
    expect(await purge()).toMatchObject({ skippedCount: 1, overdueCompanyCount: 0 });
    expect(AppLogger.error).not.toHaveBeenCalled();

    const overdue = await seed(10);
    expect(await purge()).toMatchObject({ skippedCount: 2, overdueCompanyCount: 1 });
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Chat content is overdue for deletion",
        metadata: expect.objectContaining({ companyId: shortCompany, overdueHours: 72 }),
      }),
    );

    vi.restoreAllMocks();
    expect(await purge()).toMatchObject({ purgedCount: 2 });
    expect((await row(recent)).contentPurgedAt).not.toBeNull();
    expect((await row(overdue)).contentPurgedAt).not.toBeNull();
  });

  it("closes an Open chat with the outcome its messages show", async () => {
    const answered = await seed();
    const abandoned = await seed();
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(docGaps).where(eq(docGaps.conversationId, conversationIds[answered]!));
      const replies = await ownerDb
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, conversationIds[abandoned]!));
      await ownerDb.delete(feedback).where(
        inArray(
          feedback.messageId,
          replies.map((reply) => reply.id),
        ),
      );
      const conditions = [
        eq(messages.sessionMessageId, "m2"),
        eq(messages.conversationId, conversationIds[abandoned]!),
      ];
      await ownerDb.delete(messages).where(and(...conditions));
    });

    expect(await purge()).toMatchObject({ purgedCount: 2 });
    expect((await row(answered)).outcome).toBe(Schemas.ConversationOutcomeIntEnum.Answered);
    expect((await row(abandoned)).outcome).toBe(Schemas.ConversationOutcomeIntEnum.Abandoned);
  });

  it("refuses to resume a purged chat", async () => {
    const chat = await seed();
    expect(await purge()).toMatchObject({ purgedCount: 1 });
    const resumed = await new ConversationsRepo(env).startOrResume({
      identity: {
        companyId: shortCompany,
        connectionId: "1",
        connectionEnvironment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        chatbotId: shortChat.chatbotId,
        chatbotPublicId: "unused",
        chatbotName: "Short",
        hostUserId: shortHostUserId,
        displayName: null,
        roles: [],
        tokenExpiresAt: new Date(Date.now() + 60_000),
      },
      conversationPublicId: chat,
    });
    expect(resumed).toMatchObject({
      isSuccess: false,
      failure: Schemas.ConversationStartFailureEnum.NotFound,
    });
  });
});
