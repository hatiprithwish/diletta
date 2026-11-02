import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, asc, count, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  activityRollups,
  admins,
  changeRequests,
  chatbotConfigs,
  chatbots,
  chatbotUsers,
  companies,
  conversations,
  eventOutbox,
  knowledgeSources,
  modelCalls,
  qualityIssues,
  roiAssumptions,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import worker from "@/index";
import { setQualityIssueChatbots } from "@/tests/helpers/qualityIssues";
import ActivityRollupsRepo from "@/repositories/ActivityRollupsRepo";
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

// DEV_NOTE: M4-3 "Done when": the pages' numbers for a sample day match the raw model_calls and change request events.
// Tests hit the Neon staging branch; the Repo runs as diletta_app (HYPERDRIVE), so RLS applies; fixtures, the raw
// sums and cleanup run as the owner. The sample day is two days ago, inside every range, and is rolled up by the real
// ActivityRollupsRepo.rebuildDay. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const TODAY = Schemas.activityRollupDayKey(Date.now());
const DAY = Schemas.activityRollupAddDays(TODAY, -2);
const at = (time: string) => new Date(`${DAY}T${time}Z`);
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const toolName = `update_record_${crypto.randomUUID().slice(0, 8)}`;
const MODEL = "claude-sonnet-5-5";
const EMBED_MODEL = "@cf/baai/bge-m3";

let companyA = "";
let companyB = "";
let adminAId = "";
let chatbot1 = "";
let chatbot1PublicId = "";
let chatbot2 = "";

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// DEV_NOTE: The company's audit rows (M4-9) of one entity type, oldest first, read as the owner
async function auditEvents(companyId: string, entityType: string) {
  let rows: {
    actorType: number;
    entityAction: string;
    entityVersion: number | null;
    detail: unknown;
  }[] = [];
  await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, entityType),
    ];
    rows = await ownerDb
      .select({
        actorType: activityLog.actorType,
        entityAction: activityLog.entityAction,
        entityVersion: activityLog.entityVersion,
        detail: activityLog.detail,
      })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  });
  return rows;
}

async function call<T>(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: T & Schemas.ApiResponse }> {
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
  return { status: response.status, body: (await response.json()) as T & Schemas.ApiResponse };
}

// The raw truth for the sample day, straight from model_calls (owner connection, no rollup)
async function rawModelCalls(chatbotId: string | null) {
  const { start, end } = Schemas.activityRollupDayRange(DAY);
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(modelCalls.companyId, companyA),
      gte(modelCalls.createdAt, start),
      lt(modelCalls.createdAt, end),
    ];
    if (chatbotId !== null) conditions.push(eq(modelCalls.chatbotId, chatbotId));
    const [all] = await ownerDb
      .select({ count: count() })
      .from(modelCalls)
      .where(and(...conditions));
    const paid = [
      ...conditions,
      ne(modelCalls.provider, Schemas.PlatformModelProviderEnum.WorkersAi),
    ];
    const [spend] = await ownerDb
      .select({ cost: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)::numeric(14, 6)::text` })
      .from(modelCalls)
      .where(and(...paid));
    return { count: all!.count, spendUsd: spend!.cost };
  });
}

async function rawChangeEvents(action: Schemas.ChangeRequestEntityActionEnum) {
  const { start, end } = Schemas.activityRollupDayRange(DAY);
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyA),
      eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
      eq(activityLog.entityAction, action),
      gte(activityLog.createdAt, start),
      lt(activityLog.createdAt, end),
    ];
    const [result] = await ownerDb
      .select({ count: count() })
      .from(activityLog)
      .where(and(...conditions));
    return result!.count;
  });
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        {
          publicId: Utility.generatePublicId(),
          name: `Insights A ${crypto.randomUUID()}`,
          spendingBudget: "25.000000",
        },
        { publicId: Utility.generatePublicId(), name: `Insights B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    const insertedAdmins = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null },
        { clerkUserId: adminA, companyId: companyA, name: "Ana Ruiz" },
        { clerkUserId: adminB, companyId: companyB },
      ])
      .returning({ id: admins.id, clerkUserId: admins.clerkUserId });
    adminAId = insertedAdmins.find((admin) => admin.clerkUserId === adminA)!.id;

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          name: "Support",
          isDefault: true,
        },
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Sales" },
      ])
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    chatbot1 = bots[0]!.id;
    chatbot1PublicId = bots[0]!.publicId;
    chatbot2 = bots[1]!.id;
    await ownerDb.insert(chatbotConfigs).values({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotId: chatbot1,
      configVersion: 3,
      status: Schemas.ChatbotConfigStatusIntEnum.Published,
      body: {},
      bodyHash: "insights-test",
      publishedBy: adminAId,
      publishedAt: at("08:00:00"),
    });

    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    const conversation = (chatbotId: string, createdAt: Date, outcome: number | null) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotUserId: user!.id,
      chatbotId,
      status: outcome
        ? Schemas.ConversationStatusIntEnum.Closed
        : Schemas.ConversationStatusIntEnum.Open,
      outcome,
      createdAt,
      updatedAt: createdAt,
    });
    const convs = await ownerDb
      .insert(conversations)
      .values([
        conversation(chatbot1, at("09:00:00"), Schemas.ConversationOutcomeIntEnum.Answered),
        conversation(chatbot1, at("10:00:00"), Schemas.ConversationOutcomeIntEnum.Answered),
        conversation(chatbot2, at("11:00:00"), Schemas.ConversationOutcomeIntEnum.Handoff),
      ])
      .returning({ id: conversations.id });

    const [tool] = await ownerDb
      .insert(toolDefinitions)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        connectionId: "0",
        name: toolName,
        version: 1,
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
    const calls = await ownerDb
      .insert(toolCalls)
      .values(
        [convs[0]!.id, convs[1]!.id, convs[2]!.id].map((conversationId) => ({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId,
          turnId: crypto.randomUUID(),
          toolId: tool!.id,
          toolVersion: 1,
          status: Schemas.ToolCallStatusIntEnum.Ok,
        })),
      )
      .returning({ id: toolCalls.id, conversationId: toolCalls.conversationId });
    const changes = await ownerDb
      .insert(changeRequests)
      .values(
        calls.map((toolCall, index) => ({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId: toolCall.conversationId,
          toolCallId: toolCall.id,
          status:
            index === 2
              ? Schemas.ChangeRequestStatusIntEnum.NeedsHuman
              : Schemas.ChangeRequestStatusIntEnum.Verified,
          summary: `${toolName}: 1 field changed`,
          changeCount: 1,
        })),
      )
      .returning({ id: changeRequests.id });
    const event = (
      entityId: string,
      entityAction: Schemas.ChangeRequestEntityActionEnum,
      createdAt: Date,
      actorType = Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
    ) => ({
      companyId: companyA,
      actorType,
      actorId: user!.id,
      entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
      entityId,
      entityAction,
      createdAt,
    });
    const { Verified, NeedsHuman, Proposed, Undone } = Schemas.ChangeRequestEntityActionEnum;
    await ownerDb.insert(activityLog).values([
      event(changes[0]!.id, Proposed, at("09:01:00")),
      event(changes[0]!.id, Verified, at("09:02:00")),
      event(changes[1]!.id, Verified, at("10:02:00")),
      // DEV_NOTE: An auto-undo (the system's): counted as undone, never taken off Impact's verified work
      event(changes[2]!.id, Undone, at("11:01:00"), Schemas.ActivityLogActorTypeIntEnum.System),
      event(changes[2]!.id, NeedsHuman, at("11:02:00")),
    ]);

    await ownerDb.insert(qualityIssues).values({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      conversationId: convs[2]!.id,
      source: Schemas.QualityIssueSourceIntEnum.Admin,
      createdBy: adminAId,
    });
    await setQualityIssueChatbots(ownerDb, [companyA]);
    await ownerDb.insert(knowledgeSources).values({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      name: "Help center",
      type: Schemas.KnowledgeSourceTypeIntEnum.Url,
      url: "https://help.example.com/a",
      syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
      status: Schemas.KnowledgeSourceStatusIntEnum.Failed,
      // DEV_NOTE: The sync set it Failed an hour ago; an admin's edit since moved only updated_at
      syncHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    const modelCall = (values: {
      chatbotId: string | null;
      taskType: Schemas.ModelTaskTypeEnum;
      tier: Schemas.ModelCallTierIntEnum;
      provider: Schemas.ModelCallProvider;
      model: string;
      costUsd: string;
      createdAt: Date;
      evalRunId?: string;
    }) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      inputTokens: 100,
      outputTokens: 10,
      ...values,
      updatedAt: values.createdAt,
    });
    const { QaAnswer, RouteIntent, EvalJudge, SearchEmbed } = Schemas.ModelTaskTypeEnum;
    const { Mid, Small, Embed } = Schemas.ModelCallTierIntEnum;
    const anthropic = Schemas.ModelProviderEnum.Anthropic;
    const workersAi = Schemas.PlatformModelProviderEnum.WorkersAi;
    await ownerDb.insert(modelCalls).values([
      modelCall({
        chatbotId: chatbot1,
        taskType: QaAnswer,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        costUsd: "0.123457",
        createdAt: at("09:00:10"),
      }),
      modelCall({
        chatbotId: chatbot1,
        taskType: RouteIntent,
        tier: Small,
        provider: anthropic,
        model: MODEL,
        costUsd: "0.000001",
        createdAt: at("09:00:05"),
      }),
      modelCall({
        chatbotId: chatbot2,
        taskType: QaAnswer,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        costUsd: "1.500000",
        createdAt: at("11:00:10"),
      }),
      modelCall({
        chatbotId: chatbot1,
        evalRunId: "0",
        taskType: EvalJudge,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        costUsd: "0.020000",
        createdAt: at("03:00:00"),
      }),
      modelCall({
        chatbotId: null,
        taskType: SearchEmbed,
        tier: Embed,
        provider: workersAi,
        model: EMBED_MODEL,
        costUsd: "0.000300",
        createdAt: at("04:00:00"),
      }),
      // DEV_NOTE: Last second of the day: still DAY's
      modelCall({
        chatbotId: chatbot1,
        taskType: QaAnswer,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        costUsd: "0.000042",
        createdAt: at("23:59:59"),
      }),
    ]);
  });

  const rebuilt = await new ActivityRollupsRepo(env).rebuildDay({ companyId: companyA, day: DAY });
  expect(rebuilt.isSuccess).toBe(true);
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityRollups).where(inArray(activityRollups.companyId, companyIds));
    await ownerDb.delete(roiAssumptions).where(inArray(roiAssumptions.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(knowledgeSources).where(inArray(knowledgeSources.companyId, companyIds));
    await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
    await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
    await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("GET /dashboard/insights/usage", () => {
  it("matches the raw model_calls of the sample day, company-wide", async () => {
    const raw = await rawModelCalls(null);
    const { status, body } = await call<Schemas.GetInsightsUsageApiResponse>(
      "GET",
      "/dashboard/insights/usage?range=7d",
      { as: adminA },
    );
    expect(status).toBe(200);
    const usage = body.usage!;
    expect(usage.spendPerDay.find((day) => day.day === DAY)?.costUsd).toBe(raw.spendUsd);
    expect(raw.spendUsd).toBe("1.643500");
    expect(usage.modelCalls.value).toBe(raw.count);
    expect(usage.spend.testRunsUsd).toBe("0.020000");
    expect(usage.byModel.reduce((total, row) => total + row.calls, 0)).toBe(raw.count);
    expect(
      usage.byUse.find((row) => row.use === Schemas.InsightsUsageUseEnum.Search),
    ).toMatchObject({ calls: 1, isIncluded: true });
  });

  it("matches one chatbot's raw model_calls with botId", async () => {
    const raw = await rawModelCalls(chatbot1);
    const { status, body } = await call<Schemas.GetInsightsUsageApiResponse>(
      "GET",
      `/dashboard/insights/usage?range=7d&botId=${chatbot1PublicId}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.usage!.spendPerDay.find((day) => day.day === DAY)?.costUsd).toBe(raw.spendUsd);
    expect(raw.spendUsd).toBe("0.143500");
    expect(body.usage!.modelCalls.value).toBe(raw.count);
  });

  it("refuses a bad range with 400 and an unknown or other company's bot with 404", async () => {
    expect((await call("GET", "/dashboard/insights/usage?range=1y", { as: adminA })).status).toBe(
      400,
    );
    expect((await call("GET", "/dashboard/insights/usage?botId=nope", { as: adminA })).status).toBe(
      404,
    );
    expect(
      (await call("GET", `/dashboard/insights/usage?botId=${chatbot1PublicId}`, { as: adminB }))
        .status,
    ).toBe(404);
  });

  it("shows another company nothing of company A (RLS, diletta_app)", async () => {
    const { status, body } = await call<Schemas.GetInsightsUsageApiResponse>(
      "GET",
      "/dashboard/insights/usage?range=7d",
      { as: adminB },
    );
    expect(status).toBe(200);
    expect(body.usage!.modelCalls.value).toBe(0);
    expect(body.usage!.spend.valueUsd).toBe("0.000000");
  });

  it("refuses an operator and a signed-out caller", async () => {
    expect((await call("GET", "/dashboard/insights/usage", { as: operator })).status).toBe(403);
    expect((await call("GET", "/dashboard/insights/usage")).status).toBe(401);
  });
});

describe("GET /dashboard/insights/overview", () => {
  it("matches the sample day's conversations and change events, and the state now", async () => {
    const verified = await rawChangeEvents(Schemas.ChangeRequestEntityActionEnum.Verified);
    const needsHuman = await rawChangeEvents(Schemas.ChangeRequestEntityActionEnum.NeedsHuman);
    const undone = await rawChangeEvents(Schemas.ChangeRequestEntityActionEnum.Undone);
    const { status, body } = await call<Schemas.GetInsightsOverviewApiResponse>(
      "GET",
      "/dashboard/insights/overview?range=7d",
      { as: adminA },
    );
    expect(status).toBe(200);
    const overview = body.overview!;
    expect(overview.conversationsPerDay.find((day) => day.day === DAY)?.value).toBe(3);
    expect(overview.changes).toEqual({ verified, undone, needsHuman });
    expect(undone).toBe(1);
    expect(verified).toBe(2);
    expect(overview.answeredRate.value).toBeCloseTo(2 / 3);
    expect(overview.monthSpend.budgetUsd).toBe("25.000000");
    expect(overview.attention).toMatchObject({
      needsHumanCount: 1,
      openIssueCount: 1,
      openUserIssueCount: 0,
      failedSourceCount: 1,
    });
    // DEV_NOTE: When the sync failed, not when the source was last edited
    expect(Date.now() - Date.parse(overview.attention.lastSourceFailedAt!)).toBeGreaterThan(
      59 * 60 * 1000,
    );
    expect(overview.liveConfig).toEqual({
      chatbotName: "Support",
      published: {
        configVersion: 3,
        publishedAt: at("08:00:00").toISOString(),
        publishedByName: "Ana Ruiz",
      },
    });
  });

  it("scopes the state now to the botId's conversations, and keeps the spend card company-wide", async () => {
    const company = await call<Schemas.GetInsightsOverviewApiResponse>(
      "GET",
      "/dashboard/insights/overview",
      { as: adminA },
    );
    const { body } = await call<Schemas.GetInsightsOverviewApiResponse>(
      "GET",
      `/dashboard/insights/overview?botId=${chatbot1PublicId}`,
      { as: adminA },
    );
    expect(body.overview!.attention).toMatchObject({ needsHumanCount: 0, openIssueCount: 0 });
    // DEV_NOTE: The budget is the company's, so its card shows the company's month, not one bot's
    expect(body.overview!.monthSpend).toEqual(company.body.overview!.monthSpend);
  });

  it("has no live config for a company without a default bot", async () => {
    const { status, body } = await call<Schemas.GetInsightsOverviewApiResponse>(
      "GET",
      "/dashboard/insights/overview",
      { as: adminB },
    );
    expect(status).toBe(200);
    expect(body.overview!.liveConfig).toBeNull();
    expect(body.overview!.monthSpend.budgetUsd).toBe(Schemas.DEFAULT_SPENDING_BUDGET_USD);
  });
});

describe("POST /dashboard/roi-assumptions and GET /dashboard/insights/impact", () => {
  it("values verified changes and answers at the minutes the company set", async () => {
    const answers = await call<Schemas.CreateRoiAssumptionApiResponse>(
      "POST",
      "/dashboard/roi-assumptions",
      { as: adminA, body: { taskType: "answers", manualMinutes: 6 } },
    );
    expect(answers.status).toBe(201);
    expect(answers.body.roiAssumption).toMatchObject({
      taskType: "answers",
      manualMinutes: "6.0",
      effectiveFrom: TODAY,
    });
    expect(answers.body.roiAssumption).not.toHaveProperty("id");
    expect(answers.body.roiAssumption).not.toHaveProperty("companyId");
    expect(answers.body.roiAssumption).not.toHaveProperty("createdBy");

    const tool = await call("POST", "/dashboard/roi-assumptions", {
      as: adminA,
      body: { taskType: `tool:${toolName}`, manualMinutes: 4.5 },
    });
    expect(tool.status).toBe(201);
    // DEV_NOTE: Each save left one audit row, labelled with the task (M4-9)
    expect(
      (await auditEvents(companyA, Schemas.AuditEntityTypeEnum.RoiAssumption)).map((event) => [
        event.entityAction,
        event.detail,
      ]),
    ).toEqual([
      [Schemas.AuditEntityActionEnum.Updated, { label: Schemas.ROI_ANSWERS_TASK_LABEL }],
      [Schemas.AuditEntityActionEnum.Updated, { label: toolName }],
    ]);

    const { status, body } = await call<Schemas.GetInsightsImpactApiResponse>(
      "GET",
      "/dashboard/insights/impact?range=90d",
      { as: adminA },
    );
    expect(status).toBe(200);
    const tasks = Object.fromEntries(body.impact!.tasks.map((task) => [task.taskType, task]));
    // 2 answered × 6 min = 0.2 h; 2 verified × 4.5 min = 0.15 h
    expect(tasks["answers"]).toMatchObject({ count: 2, manualMinutes: "6.0", hoursSaved: 0.2 });
    expect(tasks[`tool:${toolName}`]).toMatchObject({
      label: "Update a record",
      count: 2,
      manualMinutes: "4.5",
      hoursSaved: 0.15,
    });
    expect(body.impact!.tasksDone).toBe(4);
    expect(body.impact!.hoursSaved.value).toBe(0.35);
  });

  it("keeps a company's minutes to itself", async () => {
    const { body } = await call<Schemas.GetInsightsImpactApiResponse>(
      "GET",
      "/dashboard/insights/impact",
      { as: adminB },
    );
    expect(body.impact!.tasks).toEqual([
      expect.objectContaining({ taskType: "answers", manualMinutes: null, count: 0 }),
    ]);
  });

  it("refuses an unknown tool with 404, bad minutes with 400, an operator with 403", async () => {
    expect(
      (
        await call("POST", "/dashboard/roi-assumptions", {
          as: adminA,
          body: { taskType: "tool:no_such_tool", manualMinutes: 3 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/dashboard/roi-assumptions", {
          as: adminB,
          body: { taskType: `tool:${toolName}`, manualMinutes: 3 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/dashboard/roi-assumptions", {
          as: adminA,
          body: { taskType: "answers", manualMinutes: 1.25 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/dashboard/roi-assumptions", {
          as: operator,
          body: { taskType: "answers", manualMinutes: 3 },
        })
      ).status,
    ).toBe(403);
  });
});
