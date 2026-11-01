import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
import ContentRetentionRepo from "@/repositories/ContentRetentionRepo";
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
    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        { companyId: shortCompany, hostUserId: `u-${crypto.randomUUID()}` },
        { companyId: defaultCompany, hostUserId: `u-${crypto.randomUUID()}` },
      ])
      .returning({ id: chatbotUsers.id });
    const short = { companyId: shortCompany, chatbotId: bots[0]!.id, chatbotUserId: users[0]!.id };
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
    evalChat = await seedChat(ownerDb, {
      ...short,
      idleDays: 8,
      eval: { evalRunId, evalCaseId: evalCase!.id, evalAttempt: 1 },
    });
    transcriptFilePublicId = Utility.generatePublicId();
    const [file] = await ownerDb
      .insert(files)
      .values({
        publicId: transcriptFilePublicId,
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
        evalCaseId: evalCase!.id,
        attempt: 1,
        hasPassed: true,
        transcriptFileId: file!.id,
      })
      .returning({ id: evalResults.id });
    await ownerDb.update(files).set({ ownerId: result!.id }).where(eq(files.id, file!.id));
    await env.FILES_BUCKET.put(Schemas.fileR2Key(companyPublicId, transcriptFilePublicId), "{}");
  });
});

afterAll(async () => {
  await env.FILES_BUCKET.delete(Schemas.fileR2Key(companyPublicId, transcriptFilePublicId));
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
    expect(conversation.outcome).toBe(Schemas.ConversationOutcomeIntEnum.Abandoned);
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
