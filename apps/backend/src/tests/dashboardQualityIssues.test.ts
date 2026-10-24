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
  evalCases,
  eventOutbox,
  feedback,
  messages,
  qualityIssues,
} from "@/db/tables";
import worker from "@/index";
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

// DEV_NOTE: The model router stand-in: Create test never reaches a provider here. Each test sets what getModel
// answers (a mock model, or a router failure) and reads back what it was asked.
vi.mock("@/repositories/ModelRouterRepo", () => ({
  default: class {
    getModel = mocks.getModel;
  },
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

// DEV_NOTE: M4-6 "Done when": the CHECKs on source and status hold (source ↔ feedback_id / created_by, Converted ↔
// eval_case_id), through every write the Quality page makes and against a direct write. Also the list (tabs, bot
// filter, pages), the detail's excerpt, the sidebar count, triage, Mark fixed, Dismiss and Create test (draft + save).
// Tests hit the Neon staging branch; the Repos run as diletta_app (HYPERDRIVE), so RLS applies; fixtures and cleanup
// run as the owner. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const START = Date.now() - 3 * 60 * 60 * 1000;
const at = (minutes: number) => new Date(START + minutes * 60 * 1000);
const { Open, Fixed, Dismissed, Converted } = Schemas.QualityIssueStatusIntEnum;
const { User, Admin, System } = Schemas.QualityIssueSourceIntEnum;
const Tab = Schemas.QualityIssueListTabEnum;

const QUESTION = "Priya Shah here: how often do we need to run fire drills at 12 Elm Street?";
const BAD_REPLY = "Every 6 months, per the Fire safety policy.";
const FOLLOW_UP = "Are you sure?";
const LATER_REPLY = "Yes, every 6 months.";

const DRAFT: Schemas.QualityTestDraft = {
  name: "Fire drill frequency",
  messages: [
    {
      role: Schemas.EvalCaseMessageRoleEnum.User,
      text: "How often do we need to run fire drills?",
    },
  ],
  rubric: "Says fire drills run quarterly, per the current policy. Must not say every 6 months.",
};

let companyA = "";
let companyB = "";
let adminAId = "";
let supportId = "";
let supportPublicId = "";
let salesPublicId = "";
let ratedMessageId = "";
let userConversationId = "";
// DEV_NOTE: Company A's issues, oldest first: a fixed one, a dismissed one, then Open: Priya's thumbs-down, an admin flag
// on the Sales chat (whose bot has no published config), a model-error system issue on Priya's chat and an admin flag
// on a purged chat
let fixedIssue = "";
let dismissedIssue = "";
let userIssue = "";
let userIssueId = "";
let salesIssue = "";
let systemIssue = "";
let purgedIssue = "";
let otherCompanyIssue = "";
const openOrder = () => [purgedIssue, systemIssue, salesIssue, userIssue];

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

const list = (query = "", as = adminA) =>
  call<Schemas.GetQualityIssuesApiResponse>(
    "GET",
    `/dashboard/quality-issues${query ? `?${query}` : ""}`,
    { as },
  );

const detail = (publicId: string, as = adminA) =>
  call<Schemas.GetQualityIssueApiResponse>("GET", `/dashboard/quality-issues/${publicId}`, { as });

const write = (path: string, body?: unknown, method = "POST", as = adminA) =>
  call<Schemas.UpdateQualityIssueApiResponse>(method, `/dashboard/quality-issues/${path}`, {
    as,
    body,
  });

const draftFor = (publicId: string, as = adminA) =>
  call<Schemas.DraftQualityTestApiResponse>(
    "POST",
    `/dashboard/quality-issues/${publicId}/test-draft`,
    { as },
  );

async function issueRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select()
      .from(qualityIssues)
      .where(eq(qualityIssues.publicId, publicId));
    return row;
  });
}

async function issueEvents(issueId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.entityType, Schemas.QUALITY_ISSUE_ENTITY_TYPE),
      eq(activityLog.entityId, issueId),
    ];
    return await ownerDb
      .select()
      .from(activityLog)
      .where(and(...conditions));
  });
}

// DEV_NOTE: A mock model answering with this text, recording the prompts it was sent
function mockModel(answer: string) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text: answer }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  mocks.getModel.mockResolvedValue({ isSuccess: true, model });
  return prompts;
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Quality A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Quality B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    const createdAdmins = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null },
        { clerkUserId: adminA, companyId: companyA, name: "Ana Ruiz" },
        { clerkUserId: adminB, companyId: companyB },
      ])
      .returning({ id: admins.id, clerkUserId: admins.clerkUserId });
    adminAId = createdAdmins.find((row) => row.clerkUserId === adminA)!.id;
    const adminBId = createdAdmins.find((row) => row.clerkUserId === adminB)!.id;

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" },
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Sales" },
        { publicId: Utility.generatePublicId(), companyId: companyB, name: "Other" },
      ])
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    const [support, sales, other] = bots;
    supportId = support!.id;
    supportPublicId = support!.publicId;
    salesPublicId = sales!.publicId;

    const normalized = Schemas.normalizeConfigBody({
      persona: { instructions: "You help facility managers." },
      procedures: [],
      tools: [],
      approvalRules: [],
      routing: {
        small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
        mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
        top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
        defaultTier: Schemas.ModelTierEnum.Small,
      },
      knowledge: { sourceIds: [] },
      widget: { greeting: "Hi", suggestions: [] },
    });
    if (!normalized.body || !normalized.schemaVersion) throw new Error("Config body invalid");
    await ownerDb.insert(chatbotConfigs).values({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotId: support!.id,
      configVersion: 1,
      schemaVersion: normalized.schemaVersion,
      status: Schemas.ChatbotConfigStatusIntEnum.Published,
      body: normalized.body,
      bodyHash: "quality-test-1",
      publishedAt: at(-60),
    });

    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        {
          companyId: companyA,
          hostUserId: `host_${crypto.randomUUID()}`,
          displayName: "Priya Shah",
        },
        { companyId: companyB, hostUserId: `host_${crypto.randomUUID()}`, displayName: "Bea" },
      ])
      .returning({ id: chatbotUsers.id });
    const [priya, bea] = users;

    const conversation = (
      companyId: string,
      chatbotUserId: string,
      chatbotId: string,
      title: string,
      contentPurgedAt: Date | null = null,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotUserId,
      chatbotId,
      title,
      contentPurgedAt,
      createdAt: at(0),
    });
    const convs = await ownerDb
      .insert(conversations)
      .values([
        conversation(companyA, priya!.id, support!.id, "Fire drill frequency"),
        conversation(companyA, priya!.id, sales!.id, "Scheduled exports"),
        conversation(companyA, priya!.id, support!.id, "Purged chat", at(5)),
        conversation(companyB, bea!.id, other!.id, "Company B's"),
      ])
      .returning({ id: conversations.id });
    const [userConv, salesConv, purgedConv, beaConv] = convs;
    userConversationId = userConv!.id;

    const message = (
      role: Schemas.MessageRoleIntEnum,
      text: string | null,
      turnId: string,
      minute: number,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      conversationId: userConv!.id,
      sessionMessageId: crypto.randomUUID(),
      turnId,
      role,
      content: text === null ? null : { text },
      createdAt: at(minute),
    });
    const turn1 = Utility.generateUlid();
    const turn2 = Utility.generateUlid();
    const rows = await ownerDb
      .insert(messages)
      .values([
        message(Schemas.MessageRoleIntEnum.User, QUESTION, turn1, 1),
        message(Schemas.MessageRoleIntEnum.Assistant, BAD_REPLY, turn1, 1),
        message(Schemas.MessageRoleIntEnum.User, FOLLOW_UP, turn2, 2),
        message(Schemas.MessageRoleIntEnum.Assistant, LATER_REPLY, turn2, 2),
      ])
      .returning({ id: messages.id });
    ratedMessageId = rows[1]!.id;
    await ownerDb.insert(messages).values([
      {
        ...message(Schemas.MessageRoleIntEnum.User, "Can exports be scheduled?", turn1, 1),
        conversationId: salesConv!.id,
      },
      {
        ...message(Schemas.MessageRoleIntEnum.Assistant, "Yes, every week.", turn1, 1),
        conversationId: salesConv!.id,
      },
    ]);
    const [rating] = await ownerDb
      .insert(feedback)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        messageId: ratedMessageId,
        chatbotUserId: priya!.id,
        rating: Schemas.FeedbackRatingIntEnum.Down,
      })
      .returning({ id: feedback.id });

    const issue = (values: {
      companyId?: string;
      conversationId: string;
      source: Schemas.QualityIssueSourceIntEnum;
      status?: Schemas.QualityIssueStatusIntEnum;
      issueType?: Schemas.QualityIssueTypeIntEnum;
      note?: string;
      feedbackId?: string;
      createdBy?: string;
      minute: number;
    }) => ({
      publicId: Utility.generatePublicId(),
      companyId: values.companyId ?? companyA,
      conversationId: values.conversationId,
      source: values.source,
      status: values.status ?? Open,
      issueType: values.issueType ?? null,
      note: values.note ?? null,
      feedbackId: values.feedbackId ?? null,
      createdBy: values.createdBy ?? null,
      createdAt: at(values.minute),
      updatedAt: at(values.minute),
    });
    const issues = await ownerDb
      .insert(qualityIssues)
      .values([
        issue({
          conversationId: salesConv!.id,
          source: Admin,
          status: Fixed,
          createdBy: adminAId,
          minute: 3,
        }),
        issue({ conversationId: salesConv!.id, source: System, status: Dismissed, minute: 4 }),
        issue({ conversationId: userConv!.id, source: User, feedbackId: rating!.id, minute: 10 }),
        issue({
          conversationId: salesConv!.id,
          source: Admin,
          createdBy: adminAId,
          note: "Said exports can be scheduled. They can't.",
          minute: 11,
        }),
        issue({
          conversationId: userConv!.id,
          source: System,
          issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
          note: "Anthropic key rejected",
          minute: 12,
        }),
        issue({ conversationId: purgedConv!.id, source: Admin, createdBy: adminAId, minute: 13 }),
        issue({
          companyId: companyB,
          conversationId: beaConv!.id,
          source: Admin,
          createdBy: adminBId,
          minute: 10,
        }),
      ])
      .returning({ id: qualityIssues.id, publicId: qualityIssues.publicId });
    [
      fixedIssue,
      dismissedIssue,
      userIssue,
      salesIssue,
      systemIssue,
      purgedIssue,
      otherCompanyIssue,
    ] = issues.map((row) => row.publicId);
    userIssueId = issues[2]!.id;
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
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(evalCases).where(inArray(evalCases.companyId, companyIds));
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

// DEV_NOTE: The reads run before any write below changes a status
describe("GET /dashboard/quality-issues", () => {
  it("lists the open issues newest first with every tab's count", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.qualityIssues?.map((row) => row.publicId)).toEqual(openOrder());
    expect(body.tabCounts).toEqual({
      [Tab.Open]: 4,
      [Tab.Converted]: 0,
      [Tab.Fixed]: 1,
      [Tab.Dismissed]: 1,
    });
    expect(body.totalRecords).toBe(4);

    const byId = new Map(body.qualityIssues?.map((row) => [row.publicId, row]));
    expect(byId.get(userIssue)).toMatchObject({
      source: User,
      sourceLabel: Schemas.QualityIssueSourceLabelEnum.User,
      qualityIssueStatus: Open,
      qualityIssueStatusLabel: Schemas.QualityIssueStatusLabelEnum.Open,
      issueType: null,
      issueTypeLabel: null,
      note: null,
      ratedReply: BAD_REPLY,
      conversation: { title: "Fire drill frequency" },
    });
    expect(byId.get(systemIssue)).toMatchObject({
      sourceLabel: Schemas.QualityIssueSourceLabelEnum.System,
      issueTypeLabel: Schemas.QualityIssueTypeLabelEnum.ModelError,
      ratedReply: null,
    });
    // DEV_NOTE: A purged chat keeps its issue, not its title
    expect(byId.get(purgedIssue)?.conversation.title).toBeNull();
  });

  it("filters by tab and by chatbot, keeping the counts under the chatbot filter", async () => {
    const fixed = await list(`tab=${Tab.Fixed}`);
    expect(fixed.body.qualityIssues?.map((row) => row.publicId)).toEqual([fixedIssue]);
    const dismissed = await list(`tab=${Tab.Dismissed}`);
    expect(dismissed.body.qualityIssues?.map((row) => row.publicId)).toEqual([dismissedIssue]);

    const sales = await list(`botId=${salesPublicId}`);
    expect(sales.body.qualityIssues?.map((row) => row.publicId)).toEqual([salesIssue]);
    expect(sales.body.tabCounts).toMatchObject({
      [Tab.Open]: 1,
      [Tab.Fixed]: 1,
      [Tab.Dismissed]: 1,
    });
    const support = await list(`botId=${supportPublicId}`);
    expect(support.body.qualityIssues?.map((row) => row.publicId)).toEqual([
      purgedIssue,
      systemIssue,
      userIssue,
    ]);
  });

  it("pages with a stable order", async () => {
    const first = await list("pageNo=1&pageSize=3");
    const second = await list("pageNo=2&pageSize=3");
    expect(
      [...(first.body.qualityIssues ?? []), ...(second.body.qualityIssues ?? [])].map(
        (row) => row.publicId,
      ),
    ).toEqual(openOrder());
  });

  it("refuses a bad filter with 400 and an unknown chatbot with 404", async () => {
    expect((await list("tab=nope")).status).toBe(400);
    expect((await list(`botId=${Utility.generatePublicId()}`)).status).toBe(404);
  });

  it("shows another company only its own (RLS, diletta_app), and refuses an operator and a signed-out caller", async () => {
    const other = await list("", adminB);
    expect(other.body.qualityIssues?.map((row) => row.publicId)).toEqual([otherCompanyIssue]);
    expect(other.text).not.toContain(userIssue);
    expect((await list("", operator)).status).toBe(403);
    expect((await call("GET", "/dashboard/quality-issues")).status).toBe(401);
  });

  it("counts the company's open issues for the sidebar", async () => {
    const { status, body } = await call<Schemas.GetQualityIssuesOpenCountApiResponse>(
      "GET",
      "/dashboard/quality-issues/open-count",
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.openCount).toBe(4);
  });
});

describe("GET /dashboard/quality-issues/:publicId", () => {
  it("shows a user issue with the question and the rated reply, and the rating as it stands", async () => {
    const { status, body } = await detail(userIssue);
    expect(status).toBe(200);
    expect(body.qualityIssue).toMatchObject({
      publicId: userIssue,
      rating: Schemas.FeedbackRatingIntEnum.Down,
      excerpt: [
        { role: Schemas.MessageRoleIntEnum.User, text: QUESTION },
        { role: Schemas.MessageRoleIntEnum.Assistant, text: BAD_REPLY },
      ],
      conversation: {
        title: "Fire drill frequency",
        chatbotName: "Support",
        userName: "Priya Shah",
      },
      changeRequestPublicId: null,
      evalCase: null,
    });
  });

  it("shows another issue with the conversation's last answered turn, and a purged chat with none", async () => {
    const system = await detail(systemIssue);
    expect(system.body.qualityIssue?.excerpt).toEqual([
      { role: Schemas.MessageRoleIntEnum.User, text: FOLLOW_UP },
      { role: Schemas.MessageRoleIntEnum.Assistant, text: LATER_REPLY },
    ]);
    expect(system.body.qualityIssue?.isContentPurged).toBe(false);
    const purged = await detail(purgedIssue);
    expect(purged.body.qualityIssue?.excerpt).toEqual([]);
    expect(purged.body.qualityIssue?.isContentPurged).toBe(true);
  });

  it("refuses another company's issue and an unknown one with 404, and an operator with 403", async () => {
    expect((await detail(otherCompanyIssue)).status).toBe(404);
    expect((await detail(Utility.generatePublicId())).status).toBe(404);
    expect((await detail(userIssue, operator)).status).toBe(403);
  });
});

describe("PATCH /dashboard/quality-issues/:publicId (triage)", () => {
  it("sets the type and note of an open issue, with a triaged event that never holds the note", async () => {
    const { status, body } = await write(
      salesIssue,
      { issueType: Schemas.QualityIssueTypeIntEnum.ModelError, note: "  Promised a feature  " },
      "PATCH",
    );
    expect(status).toBe(200);
    expect(body.qualityIssue).toMatchObject({
      issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
      issueTypeLabel: Schemas.QualityIssueTypeLabelEnum.ModelError,
      note: "Promised a feature",
      qualityIssueStatus: Open,
    });
    const row = await issueRow(salesIssue);
    expect(row?.updatedBy).toBe(adminAId);
    const events = await issueEvents(row!.id);
    const triaged = events.filter(
      (event) => event.entityAction === Schemas.QualityIssueEntityActionEnum.Triaged,
    );
    expect(triaged).toHaveLength(1);
    expect(triaged[0]?.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.Admin);
    expect(JSON.stringify(triaged[0]?.detail)).not.toContain("Promised");
  });

  it("clears a note sent blank and keeps the type when only the note is sent", async () => {
    const { body } = await write(salesIssue, { note: "   " }, "PATCH");
    expect(body.qualityIssue).toMatchObject({
      note: null,
      issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
    });
  });

  it("refuses an empty change or an unknown type with 400, and a closed issue with 409", async () => {
    expect((await write(salesIssue, {}, "PATCH")).status).toBe(400);
    expect((await write(salesIssue, { issueType: 99 }, "PATCH")).status).toBe(400);
    const closed = await write(fixedIssue, { note: "late" }, "PATCH");
    expect(closed.status).toBe(409);
    expect(closed.body.failure).toBe(Schemas.QualityIssueUpdateFailureEnum.NotOpen);
    expect((await issueRow(fixedIssue))?.note).toBeNull();
  });
});

describe("POST /dashboard/quality-issues/:publicId/test-draft", () => {
  it("rewrites the chat up to the rated reply on the chatbot's routing, as the chatbot's call (no conversation)", async () => {
    const prompts = mockModel(JSON.stringify(DRAFT));
    const { status, body } = await draftFor(userIssue);
    expect(status).toBe(200);
    expect(body.draft).toEqual(DRAFT);

    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: companyA,
        chatbotId: supportId,
        chatbotUserId: null,
        conversationId: null,
        turnId: null,
        taskType: Schemas.ModelTaskTypeEnum.QualityTestRewrite,
        tier: Schemas.ModelTierEnum.Mid,
      }),
    );
    expect(prompts[0]).toContain("12 Elm Street");
    expect(prompts[0]).toContain(BAD_REPLY);
    // DEV_NOTE: What came after the rated reply is not the question the test asks
    expect(prompts[0]).not.toContain(FOLLOW_UP);
    // DEV_NOTE: Nothing is saved by a draft
    expect((await issueRow(userIssue))?.status).toBe(Open);
  });

  it("answers 409 for a purged chat and for a chatbot with no published config, without a model call", async () => {
    const purged = await draftFor(purgedIssue);
    expect(purged.status).toBe(409);
    expect(purged.body.failure).toBe(Schemas.QualityTestDraftFailureEnum.NoConversation);
    const sales = await draftFor(salesIssue);
    expect(sales.status).toBe(409);
    expect(sales.body.failure).toBe(Schemas.QualityTestDraftFailureEnum.NoPublishedConfig);
    expect(mocks.getModel).not.toHaveBeenCalled();
  });

  it("answers 503 when the router refuses and 502 when the answer isn't a usable draft", async () => {
    mocks.getModel.mockResolvedValue({
      isSuccess: false,
      failure: Schemas.ModelRouterFailureEnum.KeyUnavailable,
    });
    const refused = await draftFor(userIssue);
    expect(refused.status).toBe(503);
    expect(refused.body.failure).toBe(Schemas.QualityTestDraftFailureEnum.ModelUnavailable);

    // DEV_NOTE: Ends with the assistant: not a question to test
    mockModel(
      JSON.stringify({
        ...DRAFT,
        messages: [{ role: Schemas.EvalCaseMessageRoleEnum.Assistant, text: "Hello" }],
      }),
    );
    const unusable = await draftFor(userIssue);
    expect(unusable.status).toBe(502);
    expect(unusable.body.failure).toBe(Schemas.QualityTestDraftFailureEnum.RewriteFailed);

    mockModel("not json");
    expect((await draftFor(userIssue)).status).toBe(502);
  });

  it("refuses a closed issue with 409 and an operator with 403", async () => {
    const closed = await draftFor(fixedIssue);
    expect(closed.status).toBe(409);
    expect(closed.body.failure).toBe(Schemas.QualityTestDraftFailureEnum.NotOpen);
    expect((await draftFor(userIssue, operator)).status).toBe(403);
  });
});

describe("POST /dashboard/quality-issues/:publicId/convert", () => {
  it("refuses a draft that doesn't end with the user's question with 400", async () => {
    const { status } = await write(`${userIssue}/convert`, {
      ...DRAFT,
      messages: [
        ...DRAFT.messages,
        { role: Schemas.EvalCaseMessageRoleEnum.Assistant, text: "Hi" },
      ],
    });
    expect(status).toBe(400);
  });

  it("saves the reviewed draft as the chatbot's test and converts the issue, with its event", async () => {
    const { status, body } = await write(`${userIssue}/convert`, DRAFT);
    expect(status).toBe(200);
    expect(body.qualityIssue).toMatchObject({
      qualityIssueStatus: Converted,
      evalCase: { name: DRAFT.name },
    });

    const row = await issueRow(userIssue);
    expect(row?.status).toBe(Converted);
    expect(row?.evalCaseId).not.toBeNull();
    const [saved] = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb.select().from(evalCases).where(eq(evalCases.id, row!.evalCaseId!)),
    );
    expect(saved).toMatchObject({
      companyId: companyA,
      chatbotId: supportId,
      name: DRAFT.name,
      isSafety: false,
      isActive: true,
      input: { schemaVersion: 1, messages: DRAFT.messages },
      expectations: { schemaVersion: 1, rubric: DRAFT.rubric },
    });
    expect(Schemas.ZEvalCaseInputV1.safeParse(saved?.input).success).toBe(true);
    const events = await issueEvents(userIssueId);
    expect(events.map((event) => event.entityAction)).toContain(
      Schemas.QualityIssueEntityActionEnum.Converted,
    );
  });

  it("refuses with 409 ChatbotNotFound when the conversation's chatbot was removed, writing nothing", async () => {
    const goneIssue = await withOwnerDb(async (ownerDb) => {
      const [bot] = await ownerDb
        .insert(chatbots)
        .values({ publicId: Utility.generatePublicId(), companyId: companyA, name: "Removed" })
        .returning({ id: chatbots.id });
      const [user] = await ownerDb
        .insert(chatbotUsers)
        .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
        .returning({ id: chatbotUsers.id });
      const [conv] = await ownerDb
        .insert(conversations)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotUserId: user!.id,
          chatbotId: bot!.id,
        })
        .returning({ id: conversations.id });
      const [issue] = await ownerDb
        .insert(qualityIssues)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId: conv!.id,
          source: Admin,
          createdBy: adminAId,
        })
        .returning({ publicId: qualityIssues.publicId });
      await ownerDb.delete(chatbots).where(eq(chatbots.id, bot!.id));
      return issue!.publicId;
    });

    const { status, body } = await write(`${goneIssue}/convert`, DRAFT);
    expect(status).toBe(409);
    expect(body.failure).toBe(Schemas.QualityIssueUpdateFailureEnum.ChatbotNotFound);
    expect((await issueRow(goneIssue))?.status).toBe(Open);
    // DEV_NOTE: Closed so the open counts the other tests read stay as they were
    expect((await write(`${goneIssue}/dismiss`)).status).toBe(200);
  });

  it("refuses a second convert with 409 and writes no second test", async () => {
    const again = await write(`${userIssue}/convert`, DRAFT);
    expect(again.status).toBe(409);
    const cases = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb.select().from(evalCases).where(eq(evalCases.companyId, companyA)),
    );
    expect(cases).toHaveLength(1);
  });
});

describe("POST /dashboard/quality-issues/:publicId/fix and /dismiss", () => {
  it("marks an open issue fixed, with its event, and refuses it again with 409", async () => {
    const { status, body } = await write(`${systemIssue}/fix`);
    expect(status).toBe(200);
    expect(body.qualityIssue?.qualityIssueStatus).toBe(Fixed);
    const row = await issueRow(systemIssue);
    expect(row).toMatchObject({ status: Fixed, evalCaseId: null, updatedBy: adminAId });
    const events = await issueEvents(row!.id);
    expect(events.map((event) => event.entityAction)).toEqual([
      Schemas.QualityIssueEntityActionEnum.Fixed,
    ]);

    const again = await write(`${systemIssue}/dismiss`);
    expect(again.status).toBe(409);
    expect((await issueRow(systemIssue))?.status).toBe(Fixed);
  });

  it("closes once when two admins act at the same time (the row lock)", async () => {
    const results = await Promise.all([write(`${salesIssue}/fix`), write(`${salesIssue}/dismiss`)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const row = await issueRow(salesIssue);
    const events = await issueEvents(row!.id);
    const closes = events.filter((event) =>
      [
        Schemas.QualityIssueEntityActionEnum.Fixed,
        Schemas.QualityIssueEntityActionEnum.Dismissed,
      ].includes(event.entityAction as Schemas.QualityIssueEntityActionEnum),
    );
    expect(closes).toHaveLength(1);
  });

  it("refuses another company's issue with 404 and an operator with 403", async () => {
    expect((await write(`${otherCompanyIssue}/dismiss`)).status).toBe(404);
    expect((await write(`${purgedIssue}/dismiss`, undefined, "POST", operator)).status).toBe(403);
  });
});

// DEV_NOTE: Done when: the CHECKs hold for any writer, not just the Repo's paths above
describe("quality_issues CHECKs", () => {
  const insertIssue = async (values: Partial<typeof qualityIssues.$inferInsert>) =>
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(qualityIssues).values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        conversationId: userConversationId,
        source: Admin,
        createdBy: adminAId,
        ...values,
      });
    });

  it("refuses a user issue without its feedback and a feedback on another source", async () => {
    await expect(insertIssue({ source: User, createdBy: null })).rejects.toMatchObject({
      cause: { constraint: "CHK_quality_issues_user_feedback_id" },
    });
    await expect(insertIssue({ feedbackId: ratedMessageId })).rejects.toMatchObject({
      cause: { constraint: "CHK_quality_issues_user_feedback_id" },
    });
  });

  it("refuses an admin issue without its admin and an admin on another source", async () => {
    await expect(insertIssue({ createdBy: null })).rejects.toMatchObject({
      cause: { constraint: "CHK_quality_issues_admin_created_by" },
    });
    await expect(insertIssue({ source: System })).rejects.toMatchObject({
      cause: { constraint: "CHK_quality_issues_admin_created_by" },
    });
  });

  it("refuses Converted without its test and a test on any other status", async () => {
    await expect(insertIssue({ status: Converted })).rejects.toMatchObject({
      cause: { constraint: "CHK_quality_issues_converted_eval_case_id" },
    });
    await expect(insertIssue({ status: Fixed, evalCaseId: "1" })).rejects.toMatchObject({
      cause: { constraint: "CHK_quality_issues_converted_eval_case_id" },
    });
  });
});
