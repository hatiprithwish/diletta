import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  changeRequests,
  chatbotConfigs,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  eventOutbox,
  feedback,
  messages,
  modelCalls,
  qualityIssues,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import worker from "@/index";
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

// DEV_NOTE: Clerk stand-in. "Authorization: Bearer <clerkUserId>" signs in as that Clerk user; no header is
// signed out. Nobody here has invite metadata, so /dashboard/me never provisions.
vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: async (request: Request) => {
        const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!userId) {
          return { isSignedIn: false, reason: "session-token-missing" };
        }
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

// DEV_NOTE: M4-4 "Done when": every turn's total equals the raw model_calls summed by turn_id (spend rows: the company
// key's, Workers AI left out as on the Usage page). Tests hit the Neon staging branch; the Repos run as diletta_app
// (HYPERDRIVE), so RLS applies; fixtures, the raw sums and cleanup run as the owner. afterAll deletes every row this
// suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const toolName = `update_record_${crypto.randomUUID().slice(0, 8)}`;
const MODEL = "claude-sonnet-5-5";
const ARG_SECRET = `arg-secret-${crypto.randomUUID()}`;
const START = Date.now() - 3 * 60 * 60 * 1000;
const at = (minutes: number) => new Date(START + minutes * 60 * 1000);
// DEV_NOTE: Turn ids are ULIDs, minted at the turn's time like the Conversation DO's
const TURN_1 = Utility.generateUlid(START);
const TURN_2 = Utility.generateUlid(START + 10 * 60 * 1000);
const TURN_DRILLS = Utility.generateUlid(START + 20 * 60 * 1000);
const TURN_PURGED = Utility.generateUlid(START + 30 * 60 * 1000);

let companyA = "";
let companyB = "";
let supportPublicId = "";
let salesPublicId = "";
let configV3PublicId = "";
let answered = ""; // c1: Support v3, answered, two turns, a change that needs a person
let answeredId = "";
let inProgress = ""; // c2: Sales, open, a reply rated down
let purged = ""; // c3: Support v3, couldn't answer, content purged
let otherCompany = ""; // company B's
let needsHumanChange = "";

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function call<T>(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: T & Schemas.ApiResponse; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T & Schemas.ApiResponse, text };
}

// The raw truth: spend model_calls of one turn (or the whole conversation), straight from the table as the owner
async function rawSpend(filter: { turnId: string } | { conversationId: string }) {
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(modelCalls.companyId, companyA),
      ne(modelCalls.provider, Schemas.PlatformModelProviderEnum.WorkersAi),
    ];
    if ("turnId" in filter) conditions.push(eq(modelCalls.turnId, filter.turnId));
    else conditions.push(eq(modelCalls.conversationId, filter.conversationId));
    const [sum] = await ownerDb
      .select({ cost: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)::numeric(14, 6)::text` })
      .from(modelCalls)
      .where(and(...conditions));
    return sum!.cost;
  });
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Conversations A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Conversations B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA, name: "Ana Ruiz" },
      { clerkUserId: adminB, companyId: companyB },
    ]);

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" },
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Sales" },
        { publicId: Utility.generatePublicId(), companyId: companyB, name: "Other" },
      ])
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    const [support, sales, other] = bots;
    supportPublicId = support!.publicId;
    salesPublicId = sales!.publicId;
    const configs = await ownerDb
      .insert(chatbotConfigs)
      .values([
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotId: support!.id,
          configVersion: 3,
          status: Schemas.ChatbotConfigStatusIntEnum.Published,
          body: {},
          bodyHash: "conversations-test-3",
          publishedAt: at(-60),
        },
        // DEV_NOTE: Never published: not a Config filter choice
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotId: support!.id,
          configVersion: 4,
          status: Schemas.ChatbotConfigStatusIntEnum.Draft,
          body: {},
          bodyHash: "conversations-test-4",
        },
      ])
      .returning({ id: chatbotConfigs.id, publicId: chatbotConfigs.publicId });
    configV3PublicId = configs[0]!.publicId;

    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        {
          companyId: companyA,
          hostUserId: `host_${crypto.randomUUID()}`,
          displayName: "Priya Shah",
        },
        { companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` },
        { companyId: companyB, hostUserId: `host_${crypto.randomUUID()}`, displayName: "Bea" },
      ])
      .returning({ id: chatbotUsers.id });
    const [priya, anonymous, bea] = users;

    const convs = await ownerDb
      .insert(conversations)
      .values([
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotUserId: priya!.id,
          chatbotId: support!.id,
          chatbotConfigId: configs[0]!.id,
          status: Schemas.ConversationStatusIntEnum.Closed,
          outcome: Schemas.ConversationOutcomeIntEnum.Answered,
          title: "Which Building B inspections are still open?",
          createdAt: at(0),
          lastActivityAt: at(12),
        },
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotUserId: anonymous!.id,
          chatbotId: sales!.id,
          title: "How often do we run fire drills?",
          createdAt: at(20),
          lastActivityAt: at(21),
        },
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotUserId: priya!.id,
          chatbotId: support!.id,
          chatbotConfigId: configs[0]!.id,
          status: Schemas.ConversationStatusIntEnum.Closed,
          outcome: Schemas.ConversationOutcomeIntEnum.Idk,
          title: "Purged question",
          contentPurgedAt: at(40),
          createdAt: at(30),
          lastActivityAt: at(31),
        },
        {
          publicId: Utility.generatePublicId(),
          companyId: companyB,
          chatbotUserId: bea!.id,
          chatbotId: other!.id,
          title: "Company B's",
          createdAt: at(0),
        },
      ])
      .returning({ id: conversations.id, publicId: conversations.publicId });
    answered = convs[0]!.publicId;
    answeredId = convs[0]!.id;
    inProgress = convs[1]!.publicId;
    purged = convs[2]!.publicId;
    otherCompany = convs[3]!.publicId;

    const msg = (
      conversationId: string,
      turnId: string,
      role: Schemas.MessageRoleIntEnum,
      content: Schemas.MessageContent | null,
      createdAt: Date,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      conversationId,
      sessionMessageId: crypto.randomUUID(),
      turnId,
      role,
      content,
      createdAt,
    });
    const { User, Assistant } = Schemas.MessageRoleIntEnum;
    const stored = await ownerDb
      .insert(messages)
      .values([
        msg(
          convs[0]!.id,
          TURN_1,
          User,
          { text: "Which Building B inspections are still open?" },
          at(0),
        ),
        msg(
          convs[0]!.id,
          TURN_1,
          Assistant,
          {
            text: "3 inspections are open [1].",
            citations: [
              { n: 1, documentPublicId: "doc_fire", title: "Fire safety", sourceUrl: null },
            ],
          },
          at(1),
        ),
        msg(
          convs[0]!.id,
          TURN_2,
          User,
          { text: "Close the three Building B inspections." },
          at(10),
        ),
        msg(convs[0]!.id, TURN_2, Assistant, { text: "This change needs a person." }, at(12)),
        msg(convs[1]!.id, TURN_DRILLS, User, { text: "Drills?" }, at(20)),
        msg(convs[1]!.id, TURN_DRILLS, Assistant, { text: "Twice a year." }, at(21)),
        msg(convs[2]!.id, TURN_PURGED, User, null, at(30)),
      ])
      .returning({ id: messages.id, role: messages.role, conversationId: messages.conversationId });
    const answerReply = stored[1]!;
    const drillsReply = stored[5]!;
    await ownerDb.insert(feedback).values([
      {
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        messageId: answerReply.id,
        chatbotUserId: priya!.id,
        rating: Schemas.FeedbackRatingIntEnum.Up,
      },
      {
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        messageId: drillsReply.id,
        chatbotUserId: anonymous!.id,
        rating: Schemas.FeedbackRatingIntEnum.Down,
      },
    ]);

    const [tool] = await ownerDb
      .insert(toolDefinitions)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        connectionId: "0",
        name: toolName,
        version: 3,
        description: "Update a record",
        risk: Schemas.ToolDefinitionRiskIntEnum.Write,
        status: Schemas.ToolDefinitionStatusIntEnum.Active,
        inputSchema: {},
        callOp: {},
        readbackOp: {},
        idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated,
        approval: Schemas.ToolDefinitionApprovalIntEnum.Always,
        source: Schemas.ToolDefinitionSourceIntEnum.Manual,
      })
      .returning({ id: toolDefinitions.id });
    const [toolCall] = await ownerDb
      .insert(toolCalls)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        conversationId: convs[0]!.id,
        turnId: TURN_2,
        toolId: tool!.id,
        toolVersion: 3,
        // DEV_NOTE: Stand-in ciphertext holding a recognisable value: it must never reach a response
        encryptedArgs: Buffer.from(ARG_SECRET),
        iv: Buffer.from("iv"),
        encryptionKeyVersion: 1,
        status: Schemas.ToolCallStatusIntEnum.Ok,
        createdAt: at(11),
      })
      .returning({ id: toolCalls.id });
    const [change] = await ownerDb
      .insert(changeRequests)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        conversationId: convs[0]!.id,
        toolCallId: toolCall!.id,
        status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
        encryptedChanges: Buffer.from(ARG_SECRET),
        iv: Buffer.from("iv"),
        encryptionKeyVersion: 1,
        summary: `${toolName}: 3 fields changed`,
        changeCount: 3,
        errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
      })
      .returning({ publicId: changeRequests.publicId });
    needsHumanChange = change!.publicId;

    const modelCall = (values: {
      conversationId: string;
      turnId: string | null;
      provider: Schemas.ModelCallProvider;
      costUsd: string;
      usageStatus?: Schemas.ModelCallUsageStatusIntEnum;
    }) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotId: support!.id,
      taskType:
        values.provider === Schemas.PlatformModelProviderEnum.WorkersAi
          ? Schemas.ModelTaskTypeEnum.SearchEmbed
          : Schemas.ModelTaskTypeEnum.QaAnswer,
      tier:
        values.provider === Schemas.PlatformModelProviderEnum.WorkersAi
          ? Schemas.ModelCallTierIntEnum.Embed
          : Schemas.ModelCallTierIntEnum.Mid,
      model: MODEL,
      inputTokens: 100,
      outputTokens: 10,
      ...values,
    });
    const anthropic = Schemas.ModelProviderEnum.Anthropic;
    const workersAi = Schemas.PlatformModelProviderEnum.WorkersAi;
    await ownerDb.insert(modelCalls).values([
      modelCall({
        conversationId: answeredId,
        turnId: TURN_1,
        provider: anthropic,
        costUsd: "0.012000",
      }),
      modelCall({
        conversationId: answeredId,
        turnId: TURN_1,
        provider: anthropic,
        costUsd: "0.000345",
      }),
      // DEV_NOTE: The search's embed: platform-paid, never in a turn's cost
      modelCall({
        conversationId: answeredId,
        turnId: TURN_1,
        provider: workersAi,
        costUsd: "0.000300",
      }),
      modelCall({
        conversationId: answeredId,
        turnId: TURN_2,
        provider: anthropic,
        costUsd: "0.018000",
      }),
      modelCall({
        conversationId: answeredId,
        turnId: TURN_2,
        provider: anthropic,
        costUsd: "0",
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
      }),
      modelCall({
        conversationId: answeredId,
        turnId: null,
        provider: anthropic,
        costUsd: "0.001000",
      }),
    ]);
  });
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
    await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
    await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
    await ownerDb.delete(feedback).where(inArray(feedback.companyId, companyIds));
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("GET /dashboard/conversations/:publicId", () => {
  it("totals each turn's cost exactly as model_calls summed by turn_id (Done when)", async () => {
    const { status, body } = await call<Schemas.GetConversationApiResponse>(
      "GET",
      `/dashboard/conversations/${answered}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    const conversation = body.conversation!;
    expect(conversation.turns).toHaveLength(2);
    const [turn1, turn2] = conversation.turns;
    expect(turn1!.costUsd).toBe(await rawSpend({ turnId: TURN_1 }));
    expect(turn2!.costUsd).toBe(await rawSpend({ turnId: TURN_2 }));
    expect(turn1!.costUsd).toBe("0.012345");
    expect(turn2!.costUsd).toBe("0.018000");
    expect(turn1!.costNote).toBeNull();
    expect(turn2!.costNote).toBe(Schemas.ConversationCostNoteEnum.Pending);
    // DEV_NOTE: The conversation's total adds the call with no turn
    expect(conversation.costUsd).toBe(await rawSpend({ conversationId: answeredId }));
    expect(conversation.costUsd).toBe("0.031345");
  });

  it("shows the transcript in turn order with the tool call's status and change, never its values", async () => {
    const { status, body, text } = await call<Schemas.GetConversationApiResponse>(
      "GET",
      `/dashboard/conversations/${answered}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    const conversation = body.conversation!;
    expect(conversation).toMatchObject({
      userName: "Priya Shah",
      outcomeLabel: Schemas.ConversationOutcomeLabelEnum.Answered,
      chatbotName: "Support",
      configVersion: 3,
      turnCount: 2,
      rating: Schemas.FeedbackRatingIntEnum.Up,
      isFlagged: false,
    });
    const kinds = conversation.turns[1]!.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(["message", "tool", "message"]);
    expect(conversation.turns[1]!.entries[1]).toMatchObject({
      toolName,
      toolVersion: 3,
      toolCallStatusLabel: Schemas.ToolCallStatusLabelEnum.Ok,
      change: {
        publicId: needsHumanChange,
        summary: `${toolName}: 3 fields changed`,
        changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
        errorLabel: Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.undo_failed,
      },
    });
    expect(conversation.turns[0]!.entries[1]).toMatchObject({
      text: "3 inspections are open [1].",
      citations: [{ n: 1, title: "Fire safety", sourceUrl: null }],
      ratingLabel: Schemas.FeedbackRatingLabelEnum.Up,
    });
    expect(text).not.toContain(ARG_SECRET);
    expect(text).not.toMatch(/"id":/);
    expect(text).not.toMatch(/"(companyId|conversationId|chatbotId|turnId|encrypted\w*)"/);
  });

  it("keeps a purged conversation's row and costs but none of its words", async () => {
    const { status, body } = await call<Schemas.GetConversationApiResponse>(
      "GET",
      `/dashboard/conversations/${purged}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.conversation).toMatchObject({ title: null, isContentPurged: true, turnCount: 1 });
    const entry = body.conversation!.turns[0]!.entries[0]!;
    expect(entry.kind === Schemas.ConversationTurnEntryKindEnum.Message && entry.text).toBeNull();
  });

  it("answers 404 for another company's conversation (RLS, diletta_app) and an unknown one", async () => {
    expect(
      (await call("GET", `/dashboard/conversations/${otherCompany}`, { as: adminA })).status,
    ).toBe(404);
    expect((await call("GET", `/dashboard/conversations/${answered}`, { as: adminB })).status).toBe(
      404,
    );
    expect((await call("GET", "/dashboard/conversations/nope", { as: adminA })).status).toBe(404);
  });
});

describe("GET /dashboard/conversations", () => {
  it("lists the company's conversations newest first with every tab's count and the config choices", async () => {
    const { status, body } = await call<Schemas.GetConversationsApiResponse>(
      "GET",
      "/dashboard/conversations?pageSize=10",
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.conversations!.map((row) => row.publicId)).toEqual([purged, inProgress, answered]);
    expect(body.totalRecords).toBe(3);
    expect(body.tabCounts).toMatchObject({ all: 3, rated_down: 1 });
    expect(body.configOptions).toEqual([
      { publicId: configV3PublicId, chatbotName: "Support", configVersion: 3 },
    ]);
    const open = body.conversations!.find((row) => row.publicId === inProgress)!;
    expect(open).toMatchObject({
      userName: null,
      outcome: null,
      outcomeLabel: Schemas.CONVERSATION_IN_PROGRESS_LABEL,
      configVersion: null,
      rating: Schemas.FeedbackRatingIntEnum.Down,
      turnCount: 1,
    });
    expect(body.conversations!.find((row) => row.publicId === purged)!.title).toBeNull();
  });

  const ids = async (query: string) => {
    const { status, body } = await call<Schemas.GetConversationsApiResponse>(
      "GET",
      `/dashboard/conversations?${query}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    return body.conversations!.map((row) => row.publicId).sort();
  };

  it("filters by tab", async () => {
    expect(await ids("tab=needs_attention")).toContain(answered);
    expect(await ids("tab=rated_down")).toEqual([inProgress]);
  });

  it("filters by outcome", async () => {
    expect(await ids("outcome=in_progress")).toEqual([inProgress]);
    expect(await ids("outcome=idk")).toEqual([purged]);
  });

  it("filters by config and chatbot", async () => {
    expect(await ids(`configId=${configV3PublicId}`)).toEqual([answered, purged].sort());
    expect(await ids(`botId=${salesPublicId}`)).toEqual([inProgress]);
    expect(await ids(`botId=${supportPublicId}&outcome=answered`)).toEqual([answered]);
  });

  it("pages with a stable order", async () => {
    const page = async (pageNo: number) =>
      (
        await call<Schemas.GetConversationsApiResponse>(
          "GET",
          `/dashboard/conversations?pageSize=2&pageNo=${pageNo}`,
          { as: adminA },
        )
      ).body;
    const first = await page(1);
    const second = await page(2);
    expect(first.totalRecords).toBe(3);
    expect([...first.conversations!, ...second.conversations!].map((row) => row.publicId)).toEqual([
      purged,
      inProgress,
      answered,
    ]);
  });

  it("refuses a bad filter with 400", async () => {
    expect((await call("GET", "/dashboard/conversations?tab=mine", { as: adminA })).status).toBe(
      400,
    );
    expect(
      (await call("GET", "/dashboard/conversations?pageSize=1000", { as: adminA })).status,
    ).toBe(400);
  });

  it("refuses an unknown chatbot or config with 404", async () => {
    expect((await call("GET", "/dashboard/conversations?botId=nope", { as: adminA })).status).toBe(
      404,
    );
    expect(
      (await call("GET", "/dashboard/conversations?configId=nope", { as: adminA })).status,
    ).toBe(404);
  });

  it("shows another company nothing of company A (RLS, diletta_app)", async () => {
    const { status, body } = await call<Schemas.GetConversationsApiResponse>(
      "GET",
      "/dashboard/conversations",
      { as: adminB },
    );
    expect(status).toBe(200);
    expect(body.conversations!.map((row) => row.publicId)).toEqual([otherCompany]);
    expect(
      (await call("GET", `/dashboard/conversations?botId=${supportPublicId}`, { as: adminB }))
        .status,
    ).toBe(404);
  });

  it("refuses an operator and a signed-out caller", async () => {
    expect((await call("GET", "/dashboard/conversations", { as: operator })).status).toBe(403);
    expect((await call("GET", "/dashboard/conversations")).status).toBe(401);
  });
});

describe("GET /dashboard/conversations/export", () => {
  it("returns every matching row under the filters", async () => {
    const { status, body } = await call<Schemas.ExportConversationsApiResponse>(
      "GET",
      `/dashboard/conversations/export?botId=${supportPublicId}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.isTruncated).toBe(false);
    expect(body.conversations!.map((row) => row.publicId)).toEqual([purged, answered]);
  });
});

describe("POST /dashboard/conversations/:publicId/flag", () => {
  it("opens one admin issue with its event, and a second flag opens nothing new", async () => {
    const first = await call<Schemas.FlagConversationApiResponse>(
      "POST",
      `/dashboard/conversations/${inProgress}/flag`,
      { as: adminA },
    );
    expect(first.status).toBe(201);
    expect(first.body.isCreated).toBe(true);
    expect(first.text).not.toContain("outboxId");

    const second = await call<Schemas.FlagConversationApiResponse>(
      "POST",
      `/dashboard/conversations/${inProgress}/flag`,
      { as: adminA },
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      isCreated: false,
      qualityIssuePublicId: first.body.qualityIssuePublicId,
    });

    const [issues, events] = await withOwnerDb(async (ownerDb) => {
      const issueRows = await ownerDb
        .select()
        .from(qualityIssues)
        .where(eq(qualityIssues.publicId, first.body.qualityIssuePublicId!));
      const eventConditions = [
        eq(activityLog.companyId, companyA),
        eq(activityLog.entityType, Schemas.QUALITY_ISSUE_ENTITY_TYPE),
        eq(activityLog.entityId, issueRows[0]!.id),
      ];
      const eventRows = await ownerDb
        .select()
        .from(activityLog)
        .where(and(...eventConditions));
      return [issueRows, eventRows] as const;
    });
    expect(issues[0]).toMatchObject({
      source: Schemas.QualityIssueSourceIntEnum.Admin,
      status: Schemas.QualityIssueStatusIntEnum.Open,
      issueType: null,
    });
    expect(issues[0]!.createdBy).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
      actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
    });
  });

  it("opens one issue and one event when two flags arrive at once (the advisory lock)", async () => {
    const [first, second] = await Promise.all([
      call<Schemas.FlagConversationApiResponse>(
        "POST",
        `/dashboard/conversations/${answered}/flag`,
        {
          as: adminA,
        },
      ),
      call<Schemas.FlagConversationApiResponse>(
        "POST",
        `/dashboard/conversations/${answered}/flag`,
        {
          as: adminA,
        },
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.qualityIssuePublicId).toBe(second.body.qualityIssuePublicId);

    const [issues, events] = await withOwnerDb(async (ownerDb) => {
      const issueConditions = [
        eq(qualityIssues.companyId, companyA),
        eq(qualityIssues.conversationId, answeredId),
        eq(qualityIssues.source, Schemas.QualityIssueSourceIntEnum.Admin),
      ];
      const issueRows = await ownerDb
        .select({ id: qualityIssues.id })
        .from(qualityIssues)
        .where(and(...issueConditions));
      const eventConditions = [
        eq(activityLog.companyId, companyA),
        eq(activityLog.entityType, Schemas.QUALITY_ISSUE_ENTITY_TYPE),
        inArray(
          activityLog.entityId,
          issueRows.map((row) => row.id),
        ),
      ];
      const eventRows = await ownerDb
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(...eventConditions));
      return [issueRows, eventRows] as const;
    });
    expect(issues).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("shows a flagged conversation as flagged and under Needs attention", async () => {
    const flagged = await call("POST", `/dashboard/conversations/${inProgress}/flag`, {
      as: adminA,
    });
    expect([200, 201]).toContain(flagged.status);
    const detail = await call<Schemas.GetConversationApiResponse>(
      "GET",
      `/dashboard/conversations/${inProgress}`,
      { as: adminA },
    );
    expect(detail.body.conversation!.isFlagged).toBe(true);
    const list = await call<Schemas.GetConversationsApiResponse>(
      "GET",
      "/dashboard/conversations?tab=needs_attention",
      { as: adminA },
    );
    expect(list.body.conversations!.map((row) => row.publicId).sort()).toEqual(
      [answered, inProgress].sort(),
    );
    expect(list.body.tabCounts![Schemas.ConversationListTabEnum.NeedsAttention]).toBe(2);
    expect(list.body.totalRecords).toBe(2);
  });

  it("refuses another company's conversation with 404 and an operator with 403", async () => {
    expect(
      (await call("POST", `/dashboard/conversations/${answered}/flag`, { as: adminB })).status,
    ).toBe(404);
    expect(
      (await call("POST", `/dashboard/conversations/${answered}/flag`, { as: operator })).status,
    ).toBe(403);
  });
});

describe("GET /dashboard/change-requests/:publicId", () => {
  it("shows a change with its tool and conversation, never its values", async () => {
    const { status, body, text } = await call<Schemas.GetChangeRequestApiResponse>(
      "GET",
      `/dashboard/change-requests/${needsHumanChange}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.changeRequest).toMatchObject({
      publicId: needsHumanChange,
      changeCount: 3,
      changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
      changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
      errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
      toolName,
      toolVersion: 3,
      conversation: { publicId: answered, chatbotName: "Support", userName: "Priya Shah" },
    });
    expect(text).not.toContain(ARG_SECRET);
    expect(text).not.toMatch(/"(companyId|conversationId|toolCallId|encrypted\w*|iv)"/);
  });

  it("answers 404 for another company and an unknown id, 403 for an operator", async () => {
    expect(
      (await call("GET", `/dashboard/change-requests/${needsHumanChange}`, { as: adminB })).status,
    ).toBe(404);
    expect((await call("GET", "/dashboard/change-requests/nope", { as: adminA })).status).toBe(404);
    expect(
      (await call("GET", `/dashboard/change-requests/${needsHumanChange}`, { as: operator }))
        .status,
    ).toBe(403);
  });
});
