import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import {
  activityLog,
  activityRollups,
  admins,
  changeRequests,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  feedback,
  messages,
  modelCalls,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import worker from "@/index";
import AppLogger from "@/providers/logger";
import runActivityRollups from "@/crons/ActivityRollupsCron";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
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

// DEV_NOTE: Tests hit the Neon staging branch. The Repo runs as diletta_app (HYPERDRIVE), so RLS applies; fixtures
// and cleanup run as the owner. Sources are seeded on a fixed past day (DAY), plus rows just outside it, so the
// expected rollup is exact. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const DAY = "2026-10-12";
const NEXT_DAY = "2026-10-13";
const at = (day: string, time: string) => new Date(`${day}T${time}Z`);
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const toolName = `update_record_${crypto.randomUUID().slice(0, 8)}`;
const MODEL = "claude-sonnet-5-5";
const EMBED_MODEL = "@cf/baai/bge-m3";

let companyA = "";
let companyAPublicId = "";
let companyB = "";
let chatbot1 = "";
let chatbot2 = "";

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// One company's rollups for a day as { "<chatbotId | company>|<metric>": value }
async function readRollups(companyId: string, day: string): Promise<Record<string, string>> {
  const rows = await withOwnerDb(async (ownerDb) => {
    const conditions = [eq(activityRollups.companyId, companyId), eq(activityRollups.day, day)];
    return await ownerDb
      .select()
      .from(activityRollups)
      .where(and(...conditions));
  });
  return Object.fromEntries(
    rows.map((row) => [`${row.chatbotId ?? "company"}|${row.metric}`, row.value]),
  );
}

function modelCall(values: {
  chatbotId: string | null;
  taskType: Schemas.ModelTaskTypeEnum;
  tier: Schemas.ModelCallTierIntEnum;
  provider: Schemas.ModelCallProvider;
  model: string;
  inputTokens: number;
  outputTokens: number | null;
  costUsd: string;
  createdAt: Date;
  evalRunId?: string;
}) {
  return {
    publicId: Utility.generatePublicId(),
    companyId: companyA,
    ...values,
    updatedAt: values.createdAt,
  };
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Rollups A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Rollups B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id, publicId: companies.publicId });
    companyA = created[0]!.id;
    companyAPublicId = created[0]!.publicId;
    companyB = created[1]!.id;
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
    ]);

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" },
        { publicId: Utility.generatePublicId(), companyId: companyA, name: "Sales" },
      ])
      .returning({ id: chatbots.id });
    chatbot1 = bots[0]!.id;
    chatbot2 = bots[1]!.id;
    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    const chatbotUserId = user!.id;

    const conversation = (chatbotId: string, createdAt: Date, outcome?: number) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotUserId,
      chatbotId,
      status: outcome
        ? Schemas.ConversationStatusIntEnum.Closed
        : Schemas.ConversationStatusIntEnum.Open,
      outcome: outcome ?? null,
      createdAt,
      updatedAt: createdAt,
    });
    const convs = await ownerDb
      .insert(conversations)
      .values([
        conversation(chatbot1, at(DAY, "10:00:00"), Schemas.ConversationOutcomeIntEnum.Answered),
        conversation(chatbot1, at(DAY, "11:00:00")),
        conversation(chatbot2, at(DAY, "12:00:00"), Schemas.ConversationOutcomeIntEnum.Handoff),
        // DEV_NOTE: Just after midnight: NEXT_DAY's, never DAY's
        conversation(chatbot1, at(NEXT_DAY, "00:00:00")),
      ])
      .returning({ id: conversations.id });
    const [conv1, , conv3] = convs.map((row) => row.id);

    const replies = await ownerDb
      .insert(messages)
      .values(
        [conv1!, conv3!].map((conversationId) => ({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId,
          sessionMessageId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          role: Schemas.MessageRoleIntEnum.Assistant,
        })),
      )
      .returning({ id: messages.id });
    const rating = (messageId: string, value: number, createdAt: Date, userId = chatbotUserId) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      messageId,
      chatbotUserId: userId,
      rating: value,
      createdAt,
      updatedAt: createdAt,
    });
    await ownerDb.insert(feedback).values([
      rating(replies[0]!.id, Schemas.FeedbackRatingIntEnum.Up, at(DAY, "10:05:00")),
      rating(replies[1]!.id, Schemas.FeedbackRatingIntEnum.Down, at(DAY, "12:05:00")),
      // DEV_NOTE: Given the day before (a second rater on the same reply): not DAY's
      rating(replies[0]!.id, Schemas.FeedbackRatingIntEnum.Up, at("2026-10-11", "23:59:59"), "0"),
    ]);

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
        conversationId: conv1!,
        turnId: crypto.randomUUID(),
        toolId: tool!.id,
        toolVersion: 1,
        status: Schemas.ToolCallStatusIntEnum.Ok,
      })
      .returning({ id: toolCalls.id });
    const [changeRequest] = await ownerDb
      .insert(changeRequests)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        conversationId: conv1!,
        toolCallId: toolCall!.id,
        status: Schemas.ChangeRequestStatusIntEnum.Undone,
        summary: `${toolName}: 1 field changed`,
        changeCount: 1,
      })
      .returning({ id: changeRequests.id });
    const event = (entityAction: Schemas.ChangeRequestEntityActionEnum, createdAt: Date) => ({
      companyId: companyA,
      actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
      actorId: chatbotUserId,
      entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
      entityId: changeRequest!.id,
      entityAction,
      createdAt,
    });
    await ownerDb.insert(activityLog).values([
      // DEV_NOTE: Proposed is not a counted action; the undo lands on NEXT_DAY
      event(Schemas.ChangeRequestEntityActionEnum.Proposed, at(DAY, "10:01:00")),
      event(Schemas.ChangeRequestEntityActionEnum.Verified, at(DAY, "10:02:00")),
      event(Schemas.ChangeRequestEntityActionEnum.Undone, at(NEXT_DAY, "09:00:00")),
    ]);

    const { QaAnswer, EvalJudge, SearchEmbed, KnowledgeEmbed } = Schemas.ModelTaskTypeEnum;
    const { Mid, Embed } = Schemas.ModelCallTierIntEnum;
    const anthropic = Schemas.ModelProviderEnum.Anthropic;
    const workersAi = Schemas.PlatformModelProviderEnum.WorkersAi;
    await ownerDb.insert(modelCalls).values([
      modelCall({
        chatbotId: chatbot1,
        taskType: QaAnswer,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: "0.001000",
        createdAt: at(DAY, "10:00:30"),
      }),
      modelCall({
        chatbotId: chatbot1,
        taskType: QaAnswer,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        inputTokens: 50,
        outputTokens: null,
        costUsd: "0.000500",
        createdAt: at(DAY, "23:59:59"),
      }),
      // DEV_NOTE: An eval call that carries the chatbot under test: eval keys only, never chatbot1's live usage
      modelCall({
        chatbotId: chatbot1,
        evalRunId: "0",
        taskType: EvalJudge,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: "0.010000",
        createdAt: at(DAY, "03:00:00"),
      }),
      // DEV_NOTE: A background job (no chatbot): the company-wide row only
      modelCall({
        chatbotId: null,
        taskType: KnowledgeEmbed,
        tier: Embed,
        provider: workersAi,
        model: EMBED_MODEL,
        inputTokens: 30,
        outputTokens: null,
        costUsd: "0",
        createdAt: at(DAY, "04:00:00"),
      }),
      modelCall({
        chatbotId: chatbot2,
        taskType: SearchEmbed,
        tier: Embed,
        provider: workersAi,
        model: EMBED_MODEL,
        inputTokens: 10,
        outputTokens: null,
        costUsd: "0",
        createdAt: at(DAY, "12:00:10"),
      }),
      modelCall({
        chatbotId: chatbot1,
        taskType: QaAnswer,
        tier: Mid,
        provider: anthropic,
        model: MODEL,
        inputTokens: 999,
        outputTokens: 999,
        costUsd: "9.000000",
        createdAt: at(NEXT_DAY, "00:00:00"),
      }),
    ]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(activityRollups).where(inArray(activityRollups.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
    await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
    await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
    await ownerDb.delete(feedback).where(inArray(feedback.companyId, companyIds));
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA]));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

const qa = (measure: string) => `model_calls.${measure}.task.qa.answer`;
const qaModel = (measure: string) => `model_calls.${measure}.model.anthropic/${MODEL}`;
const embed = (measure: string) => `model_calls.${measure}.task.search.embed`;
const embedModel = (measure: string) => `model_calls.${measure}.model.workers_ai/${EMBED_MODEL}`;
const knowledgeEmbed = (measure: string) => `model_calls.${measure}.task.knowledge.embed`;
const evalJudge = (measure: string) => `model_calls.eval.${measure}.task.eval.judge`;
const evalModel = (measure: string) => `model_calls.eval.${measure}.model.anthropic/${MODEL}`;
const verified = `change_requests.verified.tool.${toolName}`;

function expectedDay(): Record<string, string> {
  return {
    [`${chatbot1}|conversations.started`]: "2",
    [`${chatbot1}|conversations.outcome.answered`]: "1",
    [`${chatbot1}|feedback.up`]: "1",
    [`${chatbot1}|${verified}`]: "1",
    [`${chatbot1}|${qa("count")}`]: "2",
    [`${chatbot1}|${qa("input_tokens")}`]: "150",
    [`${chatbot1}|${qa("output_tokens")}`]: "20",
    [`${chatbot1}|${qa("cost_usd")}`]: "0.001500",
    [`${chatbot1}|${qaModel("count")}`]: "2",
    [`${chatbot1}|${qaModel("input_tokens")}`]: "150",
    [`${chatbot1}|${qaModel("output_tokens")}`]: "20",
    [`${chatbot1}|${qaModel("cost_usd")}`]: "0.001500",
    [`${chatbot1}|${evalJudge("count")}`]: "1",
    [`${chatbot1}|${evalJudge("input_tokens")}`]: "0",
    [`${chatbot1}|${evalJudge("output_tokens")}`]: "0",
    [`${chatbot1}|${evalJudge("cost_usd")}`]: "0.010000",
    [`${chatbot1}|${evalModel("count")}`]: "1",
    [`${chatbot1}|${evalModel("input_tokens")}`]: "0",
    [`${chatbot1}|${evalModel("output_tokens")}`]: "0",
    [`${chatbot1}|${evalModel("cost_usd")}`]: "0.010000",

    [`${chatbot2}|conversations.started`]: "1",
    [`${chatbot2}|conversations.outcome.handoff`]: "1",
    [`${chatbot2}|feedback.down`]: "1",
    [`${chatbot2}|${embed("count")}`]: "1",
    [`${chatbot2}|${embed("input_tokens")}`]: "10",
    [`${chatbot2}|${embed("output_tokens")}`]: "0",
    [`${chatbot2}|${embed("cost_usd")}`]: "0.000000",
    [`${chatbot2}|${embedModel("count")}`]: "1",
    [`${chatbot2}|${embedModel("input_tokens")}`]: "10",
    [`${chatbot2}|${embedModel("output_tokens")}`]: "0",
    [`${chatbot2}|${embedModel("cost_usd")}`]: "0.000000",

    // DEV_NOTE: Company-wide = every chatbot plus the calls with none (the background embed)
    "company|conversations.started": "3",
    "company|conversations.outcome.answered": "1",
    "company|conversations.outcome.handoff": "1",
    "company|feedback.up": "1",
    "company|feedback.down": "1",
    [`company|${verified}`]: "1",
    [`company|${qa("count")}`]: "2",
    [`company|${qa("input_tokens")}`]: "150",
    [`company|${qa("output_tokens")}`]: "20",
    [`company|${qa("cost_usd")}`]: "0.001500",
    [`company|${qaModel("count")}`]: "2",
    [`company|${qaModel("input_tokens")}`]: "150",
    [`company|${qaModel("output_tokens")}`]: "20",
    [`company|${qaModel("cost_usd")}`]: "0.001500",
    [`company|${evalJudge("count")}`]: "1",
    [`company|${evalJudge("input_tokens")}`]: "0",
    [`company|${evalJudge("output_tokens")}`]: "0",
    [`company|${evalJudge("cost_usd")}`]: "0.010000",
    [`company|${evalModel("count")}`]: "1",
    [`company|${evalModel("input_tokens")}`]: "0",
    [`company|${evalModel("output_tokens")}`]: "0",
    [`company|${evalModel("cost_usd")}`]: "0.010000",
    [`company|${embed("count")}`]: "1",
    [`company|${embed("input_tokens")}`]: "10",
    [`company|${embed("output_tokens")}`]: "0",
    [`company|${embed("cost_usd")}`]: "0.000000",
    [`company|${knowledgeEmbed("count")}`]: "1",
    [`company|${knowledgeEmbed("input_tokens")}`]: "30",
    [`company|${knowledgeEmbed("output_tokens")}`]: "0",
    [`company|${knowledgeEmbed("cost_usd")}`]: "0.000000",
    [`company|${embedModel("count")}`]: "2",
    [`company|${embedModel("input_tokens")}`]: "40",
    [`company|${embedModel("output_tokens")}`]: "0",
    [`company|${embedModel("cost_usd")}`]: "0.000000",
  };
}

describe("ActivityRollupsRepo.rebuildDay", () => {
  it("rolls one day up per chatbot and company-wide, from the day's rows only", async () => {
    const rebuilt = await new ActivityRollupsRepo(env).rebuildDay({
      companyId: companyA,
      day: DAY,
    });
    expect(rebuilt.isSuccess).toBe(true);
    expect(rebuilt.rowCount).toBe(Object.keys(expectedDay()).length);
    expect(await readRollups(companyA, DAY)).toEqual(expectedDay());
  });

  it("is re-runnable: the same rows again, and a metric the sources no longer hold is gone", async () => {
    const repo = new ActivityRollupsRepo(env);
    await repo.rebuildDay({ companyId: companyA, day: DAY });
    const again = await repo.rebuildDay({ companyId: companyA, day: DAY });
    expect(again.isSuccess).toBe(true);
    expect(await readRollups(companyA, DAY)).toEqual(expectedDay());

    // A stale row, and a source row removed: the next rebuild drops both
    const removed = await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(activityRollups).values({
        companyId: companyA,
        chatbotId: chatbot1,
        day: DAY,
        metric: "stale.metric",
        value: "7",
      });
      const conditions = [eq(modelCalls.companyId, companyA), eq(modelCalls.chatbotId, chatbot2)];
      return await ownerDb
        .delete(modelCalls)
        .where(and(...conditions))
        .returning();
    });
    expect(removed).toHaveLength(1);

    expect((await repo.rebuildDay({ companyId: companyA, day: DAY })).isSuccess).toBe(true);
    const rows = await readRollups(companyA, DAY);
    expect(rows).not.toHaveProperty(`${chatbot1}|stale.metric`);
    expect(Object.keys(rows).some((key) => key.includes("search.embed"))).toBe(false);
    expect(Object.keys(rows).some((key) => key.startsWith(`${chatbot2}|model_calls`))).toBe(false);
    expect(rows[`company|${embedModel("count")}`]).toBe("1");
    expect(rows[`${chatbot1}|${qa("cost_usd")}`]).toBe("0.001500");

    // Put the source row back for the other tests, then rebuild
    await withOwnerDb(async (ownerDb) => {
      // DEV_NOTE: id is GENERATED ALWAYS, so the copy goes back without it
      await ownerDb.insert(modelCalls).values(removed.map(({ id: _id, ...row }) => row));
    });
    await repo.rebuildDay({ companyId: companyA, day: DAY });
    expect(await readRollups(companyA, DAY)).toEqual(expectedDay());
  });

  it("never reads or writes another company's rows", async () => {
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.insert(activityRollups).values({
        companyId: companyB,
        chatbotId: null,
        day: DAY,
        metric: "stale.metric",
        value: "1",
      });
    });
    const repo = new ActivityRollupsRepo(env);

    // A's rebuild leaves B's row alone
    await repo.rebuildDay({ companyId: companyA, day: DAY });
    expect(await readRollups(companyB, DAY)).toEqual({ "company|stale.metric": "1" });

    // B has no sources of its own: its rebuild writes nothing of A's and clears its own day
    const rebuiltB = await repo.rebuildDay({ companyId: companyB, day: DAY });
    expect(rebuiltB).toMatchObject({ isSuccess: true, rowCount: 0 });
    expect(await readRollups(companyB, DAY)).toEqual({});
    expect(await readRollups(companyA, DAY)).toEqual(expectedDay());
  });
});

describe("ActivityRollupsRepo.rebuildDays and rebuildRecent", () => {
  it("rebuilds every day of a range, each on its own", async () => {
    const result = await new ActivityRollupsRepo(env).rebuildDays({
      companyId: companyA,
      fromDay: DAY,
      toDay: NEXT_DAY,
    });
    expect(result).toMatchObject({ isSuccess: true, rebuiltDays: [DAY, NEXT_DAY], failedDays: [] });
    expect(await readRollups(companyA, NEXT_DAY)).toMatchObject({
      [`${chatbot1}|conversations.started`]: "1",
      [`${chatbot1}|change_requests.undone.tool.${toolName}`]: "1",
      // DEV_NOTE: The chatbot user's own undo of a verified change (M4-3), apart from auto-undos
      [`${chatbot1}|change_requests.user_undone.tool.${toolName}`]: "1",
      [`${chatbot1}|${qa("cost_usd")}`]: "9.000000",
    });
  });

  it("rebuilds yesterday and today for every Active or Paused company", async () => {
    const listCompanies = vi
      .spyOn(CompaniesDAL.prototype, "getCompanyIdsByStatus")
      .mockResolvedValue({ isSuccess: true, companyIds: [companyA] });
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(activityRollups).where(eq(activityRollups.companyId, companyA));
    });

    const result = await new ActivityRollupsRepo(env).rebuildRecent({
      now: at(NEXT_DAY, "15:00:00").getTime(),
    });
    expect(result).toEqual({
      isSuccess: true,
      message: "Activity rollups rebuilt",
      rebuiltCount: 2,
      failedCount: 0,
    });
    expect(listCompanies).toHaveBeenCalledWith(expect.anything(), {
      statuses: [Schemas.CompanyStatusIntEnum.Active, Schemas.CompanyStatusIntEnum.Paused],
    });
    expect(await readRollups(companyA, DAY)).toEqual(expectedDay());
    expect(await readRollups(companyA, NEXT_DAY)).toHaveProperty(
      `${chatbot1}|conversations.started`,
      "1",
    );
  });

  it("reports a failed company list and rebuilds nothing", async () => {
    vi.spyOn(CompaniesDAL.prototype, "getCompanyIdsByStatus").mockResolvedValue({
      isSuccess: false,
      message: "Unknown error in listing company ids",
    });
    const rebuildDay = vi.spyOn(ActivityRollupsRepo.prototype, "rebuildDay");

    const result = await new ActivityRollupsRepo(env).rebuildRecent();
    expect(result).toEqual({
      isSuccess: false,
      message: "Unknown error in listing company ids",
      rebuiltCount: 0,
      failedCount: 0,
    });
    expect(rebuildDay).not.toHaveBeenCalled();
  });
});

describe("ActivityRollupsCron", () => {
  it("logs a failed run as an error, even when nothing was attempted", async () => {
    vi.spyOn(ActivityRollupsRepo.prototype, "rebuildRecent").mockResolvedValue({
      isSuccess: false,
      message: "Unknown error in platform transaction",
      rebuiltCount: 0,
      failedCount: 0,
    });
    vi.mocked(AppLogger.error).mockClear();
    await runActivityRollups(env);
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        category: Schemas.LogCategory.Rollup,
        action: Schemas.LogAction.RebuildRecentActivityRollups,
        metadata: { rebuiltCount: 0, failedCount: 0 },
      }),
    );
  });

  it("logs a clean run as info", async () => {
    vi.spyOn(ActivityRollupsRepo.prototype, "rebuildRecent").mockResolvedValue({
      isSuccess: true,
      message: "Activity rollups rebuilt",
      rebuiltCount: 2,
      failedCount: 0,
    });
    vi.mocked(AppLogger.error).mockClear();
    vi.mocked(AppLogger.info).mockClear();
    await runActivityRollups(env);
    expect(AppLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: Schemas.LogAction.RebuildRecentActivityRollups }),
    );
    expect(AppLogger.error).not.toHaveBeenCalled();
  });
});

describe("CompaniesDAL.getCompanyIdsByStatus (the hourly run's company list)", () => {
  it("lists Active and Paused companies and leaves Churned ones out, as diletta_app in withPlatform", async () => {
    const created = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .insert(companies)
        .values([
          {
            publicId: Utility.generatePublicId(),
            name: `Rollups paused ${crypto.randomUUID()}`,
            status: Schemas.CompanyStatusIntEnum.Paused,
          },
          {
            publicId: Utility.generatePublicId(),
            name: `Rollups churned ${crypto.randomUUID()}`,
            status: Schemas.CompanyStatusIntEnum.Churned,
          },
        ])
        .returning({ id: companies.id });
    });
    const [paused, churned] = created.map((row) => row.id);

    try {
      const listed = await withPlatform(getDbClient(env), async (tx) => {
        return await new CompaniesDAL().getCompanyIdsByStatus(tx, {
          statuses: [Schemas.CompanyStatusIntEnum.Active, Schemas.CompanyStatusIntEnum.Paused],
        });
      });
      expect(listed.isSuccess).toBe(true);
      const companyIds = "companyIds" in listed ? (listed.companyIds ?? []) : [];
      expect(companyIds).toEqual(expect.arrayContaining([companyA, paused]));
      expect(companyIds).not.toContain(churned);
    } finally {
      await withOwnerDb(async (ownerDb) => {
        await ownerDb.delete(companies).where(
          inArray(
            companies.id,
            created.map((row) => row.id),
          ),
        );
      });
    }
  });
});

describe("POST /operator/companies/:companyPublicId/rollups/rebuild", () => {
  const path = () => `/operator/companies/${companyAPublicId}/rollups/rebuild`;

  it("lets an operator rebuild a range of one company's days", async () => {
    const response = await call("POST", path(), {
      as: operator,
      body: { fromDay: DAY, toDay: DAY },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ isSuccess: true, rebuiltDays: [DAY], failedDays: [] });
    expect(await readRollups(companyA, DAY)).toEqual(expectedDay());
  });

  it("refuses a company admin with 403, before reading the body", async () => {
    const response = await call("POST", path(), { as: adminA, body: {} });
    expect(response.status).toBe(403);
  });

  it("refuses a signed-out caller with 401", async () => {
    const response = await call("POST", path(), { body: { fromDay: DAY, toDay: DAY } });
    expect(response.status).toBe(401);
  });

  it("answers 404 for an unknown company", async () => {
    const response = await call("POST", "/operator/companies/unknown_company/rollups/rebuild", {
      as: operator,
      body: { fromDay: DAY, toDay: DAY },
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["a reversed range", { fromDay: NEXT_DAY, toDay: DAY }],
    ["a future day", { fromDay: DAY, toDay: "2999-01-01" }],
    ["more than the cap", { fromDay: "2026-08-01", toDay: "2026-09-30" }],
    ["a malformed day", { fromDay: "12/10/2026", toDay: DAY }],
  ])("refuses %s with 400", async (_label, body) => {
    const response = await call("POST", path(), { as: operator, body });
    expect(response.status).toBe(400);
  });
});
