import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  changeRequests,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  eventOutbox,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import worker from "@/index";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
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

// DEV_NOTE: M4-5 "Done when": a change that needs a person can be resolved (Mark resolved). Also the Changes list (tabs,
// Requested by, pages), the timeline from activity_log and the sidebar count. Tests hit the Neon staging branch; the
// Repos run as diletta_app (HYPERDRIVE), so RLS applies; fixtures and cleanup run as the owner. afterAll deletes every
// row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const toolName = `update_record_${crypto.randomUUID().slice(0, 8)}`;
const VALUE_SECRET = `value-secret-${crypto.randomUUID()}`;
const PRIYA_HOST_ID = `host_priya_${crypto.randomUUID()}`;
const MARCUS_HOST_ID = `host_marcus_${crypto.randomUUID()}`;
const IDLE_HOST_ID = `host_idle_${crypto.randomUUID()}`;
const START = Date.now() - 3 * 60 * 60 * 1000;
const at = (minutes: number) => new Date(START + minutes * 60 * 1000);
const { Proposed, Committing, Verified, Undone, Rejected, NeedsHuman, Resolved } =
  Schemas.ChangeRequestStatusIntEnum;
const Tab = Schemas.ChangeRequestListTabEnum;

let companyA = "";
let companyB = "";
let adminAId = "";
let supportPublicId = "";
// DEV_NOTE: Company A's changes, oldest first: Priya's needs a person (with its events) and a proposal; Marcus's
// verified, committing (Waiting) and rejected; an unnamed user's undone; a second one of Priya's that needs a person,
// resolved by two admins at once
let needsHuman = "";
let needsHumanId = "";
let proposed = "";
let verified = "";
let committing = "";
let rejected = "";
let undone = "";
let undoneId = "";
let raced = "";
let otherCompanyChange = "";
let priyaConversationId = "";
let toolAId = "";
const listOrder = () => [raced, undone, rejected, committing, verified, proposed, needsHuman];

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
  options: { as?: string } = {},
): Promise<{ status: number; body: T & Schemas.ApiResponse; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  const request = new Request(`http://localhost${path}`, { method, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T & Schemas.ApiResponse, text };
}

const list = (query = "", as = adminA) =>
  call<Schemas.GetChangeRequestsApiResponse>(
    "GET",
    `/dashboard/change-requests${query ? `?${query}` : ""}`,
    { as },
  );

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Changes A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Changes B ${crypto.randomUUID()}` },
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

    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        { companyId: companyA, hostUserId: PRIYA_HOST_ID, displayName: "Priya Shah" },
        { companyId: companyA, hostUserId: MARCUS_HOST_ID, displayName: "Marcus Lee" },
        { companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` },
        // DEV_NOTE: No change request: never a Requested by choice
        { companyId: companyA, hostUserId: IDLE_HOST_ID, displayName: "Idle" },
        { companyId: companyB, hostUserId: `host_${crypto.randomUUID()}`, displayName: "Bea" },
      ])
      .returning({ id: chatbotUsers.id });
    const [priya, marcus, unnamed, idle, bea] = users;

    const conversation = (companyId: string, chatbotUserId: string, chatbotId: string) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotUserId,
      chatbotId,
      title: "Close the Building B inspections",
      createdAt: at(0),
    });
    const convs = await ownerDb
      .insert(conversations)
      .values([
        conversation(companyA, priya!.id, support!.id),
        conversation(companyA, marcus!.id, sales!.id),
        conversation(companyA, unnamed!.id, support!.id),
        conversation(companyA, idle!.id, support!.id),
        conversation(companyB, bea!.id, other!.id),
      ])
      .returning({ id: conversations.id });
    const [priyaConv, marcusConv, unnamedConv, , beaConv] = convs;
    priyaConversationId = priyaConv!.id;

    const [toolA, toolB] = await ownerDb
      .insert(toolDefinitions)
      .values(
        [companyA, companyB].map((companyId) => ({
          publicId: Utility.generatePublicId(),
          companyId,
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
        })),
      )
      .returning({ id: toolDefinitions.id });
    toolAId = toolA!.id;

    // DEV_NOTE: One tool call per change request (UNQ_change_requests_tool_call_id)
    const change = async (values: {
      companyId: string;
      conversationId: string;
      toolId: string;
      status: Schemas.ChangeRequestStatusIntEnum;
      minute: number;
      summary: string;
      errorCode?: Schemas.ChangeRequestErrorCodeEnum;
    }) => {
      const [toolCall] = await ownerDb
        .insert(toolCalls)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: values.companyId,
          conversationId: values.conversationId,
          turnId: Utility.generateUlid(START + values.minute * 60 * 1000),
          toolId: values.toolId,
          toolVersion: 3,
          encryptedArgs: Buffer.from(VALUE_SECRET),
          iv: Buffer.from("iv"),
          encryptionKeyVersion: 1,
          status: Schemas.ToolCallStatusIntEnum.Ok,
        })
        .returning({ id: toolCalls.id });
      const [row] = await ownerDb
        .insert(changeRequests)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: values.companyId,
          conversationId: values.conversationId,
          toolCallId: toolCall!.id,
          status: values.status,
          // DEV_NOTE: Stand-in ciphertext holding a recognisable value: it must never reach a response
          encryptedChanges: Buffer.from(VALUE_SECRET),
          iv: Buffer.from("iv"),
          encryptionKeyVersion: 1,
          summary: values.summary,
          changeCount: 3,
          errorCode: values.errorCode ?? null,
          createdAt: at(values.minute),
          updatedAt: at(values.minute),
        })
        .returning({ id: changeRequests.id, publicId: changeRequests.publicId });
      return row!;
    };

    const needs = await change({
      companyId: companyA,
      conversationId: priyaConv!.id,
      toolId: toolA!.id,
      status: NeedsHuman,
      minute: 1,
      summary: "Close 3 Building B inspections",
      errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
    });
    needsHuman = needs.publicId;
    needsHumanId = needs.id;
    proposed = (
      await change({
        companyId: companyA,
        conversationId: priyaConv!.id,
        toolId: toolA!.id,
        status: Proposed,
        minute: 2,
        summary: "Change due date on EXT-A-003",
      })
    ).publicId;
    verified = (
      await change({
        companyId: companyA,
        conversationId: marcusConv!.id,
        toolId: toolA!.id,
        status: Verified,
        minute: 3,
        summary: "Reschedule 17 overdue Q3 inspections",
      })
    ).publicId;
    committing = (
      await change({
        companyId: companyA,
        conversationId: marcusConv!.id,
        toolId: toolA!.id,
        status: Committing,
        minute: 4,
        summary: "Archive 2 expired training records",
      })
    ).publicId;
    rejected = (
      await change({
        companyId: companyA,
        conversationId: marcusConv!.id,
        toolId: toolA!.id,
        status: Rejected,
        minute: 5,
        summary: "Assign 4 incident reports",
      })
    ).publicId;
    const undoneRow = await change({
      companyId: companyA,
      conversationId: unnamedConv!.id,
      toolId: toolA!.id,
      status: Undone,
      minute: 6,
      summary: "Create permit for Halden Electrical",
    });
    undone = undoneRow.publicId;
    undoneId = undoneRow.id;
    raced = (
      await change({
        companyId: companyA,
        conversationId: priyaConv!.id,
        toolId: toolA!.id,
        status: NeedsHuman,
        minute: 7,
        summary: "Close EXT-B-020",
        errorCode: Schemas.ChangeRequestErrorCodeEnum.VerifyUnknown,
      })
    ).publicId;
    otherCompanyChange = (
      await change({
        companyId: companyB,
        conversationId: beaConv!.id,
        toolId: toolB!.id,
        status: NeedsHuman,
        minute: 1,
        summary: "Company B's",
      })
    ).publicId;

    // DEV_NOTE: The needs-a-person change's events, as the action engine writes them (one per status change)
    const logEvent = (
      entityAction: Schemas.ChangeRequestEntityActionEnum,
      seconds: number,
      overrides: {
        actorType?: Schemas.ActivityLogActorTypeIntEnum;
        actorId?: string;
        detail?: object;
      } = {},
    ) => ({
      companyId: companyA,
      actorType: overrides.actorType ?? Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: overrides.actorId ?? null,
      entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
      entityId: needs.id,
      entityAction,
      detail: overrides.detail ?? {},
      createdAt: new Date(at(1).getTime() + seconds * 1000),
    });
    const Action = Schemas.ChangeRequestEntityActionEnum;
    await ownerDb.insert(activityLog).values([
      logEvent(Action.Proposed, 3),
      logEvent(Action.Approved, 41, {
        actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
        actorId: priya!.id,
      }),
      logEvent(Action.Committing, 42),
      logEvent(Action.Committed, 43),
      logEvent(Action.Mismatch, 44),
      logEvent(Action.NeedsHuman, 45, {
        detail: { errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable },
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
    await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
    await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
    await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("GET /dashboard/change-requests", () => {
  it("lists the company's changes newest first with every tab's count", async () => {
    const { status, body, text } = await list();
    expect(status).toBe(200);
    expect(body.changeRequests!.map((row) => row.publicId)).toEqual(listOrder());
    expect(body.totalRecords).toBe(7);
    expect(body.tabCounts).toEqual({
      [Tab.All]: 7,
      [Tab.Waiting]: 2,
      [Tab.Verified]: 1,
      [Tab.Undone]: 1,
      [Tab.NeedsHuman]: 2,
    });
    const needs = body.changeRequests!.find((row) => row.publicId === needsHuman)!;
    expect(needs).toMatchObject({
      summary: "Close 3 Building B inspections",
      changeCount: 3,
      changeRequestStatus: NeedsHuman,
      changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
      errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
      toolName,
      toolVersion: 3,
      requesterName: "Priya Shah",
    });
    expect(text).not.toContain(VALUE_SECRET);
    expect(text).not.toMatch(
      /"(id|companyId|conversationId|toolCallId|chatbotUserId|encrypted\w*|iv)"/,
    );
  });

  it("filters by tab: Waiting holds what hasn't ended, Rejected shows only under All", async () => {
    const waiting = await list(`tab=${Tab.Waiting}`);
    expect(waiting.body.changeRequests!.map((row) => row.publicId)).toEqual([committing, proposed]);
    expect(waiting.body.totalRecords).toBe(2);
    const needs = await list(`tab=${Tab.NeedsHuman}`);
    expect(needs.body.changeRequests!.map((row) => row.publicId)).toEqual([raced, needsHuman]);
    for (const tab of [Tab.Waiting, Tab.Verified, Tab.Undone, Tab.NeedsHuman]) {
      const rows = (await list(`tab=${tab}`)).body.changeRequests!;
      expect(rows.map((row) => row.publicId)).not.toContain(rejected);
    }
  });

  it("filters by requester and chatbot, keeping the counts under those filters", async () => {
    const marcus = await list(`requesterId=${encodeURIComponent(MARCUS_HOST_ID)}`);
    expect(marcus.body.changeRequests!.map((row) => row.publicId)).toEqual([
      rejected,
      committing,
      verified,
    ]);
    expect(marcus.body.tabCounts![Tab.All]).toBe(3);
    expect(marcus.body.tabCounts![Tab.Waiting]).toBe(1);
    const priyaNeeds = await list(
      `requesterId=${encodeURIComponent(PRIYA_HOST_ID)}&tab=${Tab.NeedsHuman}`,
    );
    expect(priyaNeeds.body.changeRequests!.map((row) => row.publicId)).toEqual([raced, needsHuman]);
    const support = await list(`botId=${supportPublicId}`);
    expect(support.body.changeRequests!.map((row) => row.publicId)).toEqual([
      raced,
      undone,
      proposed,
      needsHuman,
    ]);
  });

  it("pages with a stable order", async () => {
    const first = await list("pageNo=1&pageSize=3");
    const second = await list("pageNo=2&pageSize=3");
    const third = await list("pageNo=3&pageSize=3");
    expect(
      [first, second, third].flatMap((page) =>
        page.body.changeRequests!.map((row) => row.publicId),
      ),
    ).toEqual(listOrder());
    expect(first.body.totalRecords).toBe(7);
  });

  it("refuses a bad filter with 400 and an unknown requester or chatbot with 404", async () => {
    expect((await list("tab=archived")).status).toBe(400);
    expect((await list("pageSize=1000")).status).toBe(400);
    expect((await list("requesterId=host_nobody")).status).toBe(404);
    expect((await list("botId=bot_nope")).status).toBe(404);
  });

  it("shows another company nothing of company A (RLS, diletta_app)", async () => {
    const { status, body } = await list("", adminB);
    expect(status).toBe(200);
    expect(body.changeRequests!.map((row) => row.publicId)).toEqual([otherCompanyChange]);
    // DEV_NOTE: Company A's requester isn't company B's to filter on
    expect((await list(`requesterId=${encodeURIComponent(PRIYA_HOST_ID)}`, adminB)).status).toBe(
      404,
    );
  });

  it("refuses an operator and a signed-out caller", async () => {
    expect((await list("", operator)).status).toBe(403);
    expect((await call("GET", "/dashboard/change-requests")).status).toBe(401);
  });
});

describe("GET /dashboard/change-requests/requesters", () => {
  const requesters = (query = "", as = adminA) =>
    call<Schemas.GetChangeRequestRequestersApiResponse>(
      "GET",
      `/dashboard/change-requests/requesters${query ? `?${query}` : ""}`,
      { as },
    );

  it("lists the users with changes, most changes first, never one without", async () => {
    const { status, body, text } = await requesters();
    expect(status).toBe(200);
    expect(body.requesters).toEqual([
      { hostUserId: MARCUS_HOST_ID, name: "Marcus Lee" },
      { hostUserId: PRIYA_HOST_ID, name: "Priya Shah" },
      { hostUserId: expect.any(String), name: null },
    ]);
    expect(text).not.toMatch(/"(id|chatbotUserId|companyId)"/);
  });

  it("adds the requester the URL picked when it isn't among them, once, and never an unknown one", async () => {
    const picked = await requesters(`requesterId=${encodeURIComponent(IDLE_HOST_ID)}`);
    expect(picked.body.requesters!.at(-1)).toEqual({ hostUserId: IDLE_HOST_ID, name: "Idle" });
    expect(picked.body.requesters).toHaveLength(4);
    const listed = await requesters(`requesterId=${encodeURIComponent(PRIYA_HOST_ID)}`);
    expect(listed.body.requesters).toHaveLength(3);
    const unknown = await requesters("requesterId=host_nobody");
    expect(unknown.status).toBe(200);
    expect(unknown.body.requesters).toHaveLength(3);
  });

  it("shows another company only its own, and refuses an operator", async () => {
    const other = await requesters(`requesterId=${encodeURIComponent(PRIYA_HOST_ID)}`, adminB);
    expect(other.body.requesters!.map((requester) => requester.name)).toEqual(["Bea"]);
    expect((await requesters("", operator)).status).toBe(403);
  });
});

describe("GET /dashboard/change-requests/:publicId timeline", () => {
  it("reads the change's events from activity_log in order, in plain words with names", async () => {
    const { status, body, text } = await call<Schemas.GetChangeRequestApiResponse>(
      "GET",
      `/dashboard/change-requests/${needsHuman}`,
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.changeRequest!.timeline.map((entry) => entry.label)).toEqual([
      "Proposed",
      "Approved by Priya Shah",
      "Saving in your app",
      "Saved in your app",
      "Check failed: your app shows other values",
      "Needs a person: the check failed and the tool can't undo",
    ]);
    expect(body.changeRequest!.timeline[1]!.createdAt).toBe(
      new Date(at(1).getTime() + 41_000).toISOString(),
    );
    expect(text).not.toContain(VALUE_SECRET);
  });

  it("keeps the newest steps when a change has more events than the timeline shows", async () => {
    const max = Schemas.CHANGE_REQUEST_TIMELINE_MAX_EVENTS;
    const base = at(6).getTime();
    await withOwnerDb((ownerDb) =>
      ownerDb.insert(activityLog).values([
        ...Array.from({ length: max + 5 }, (_, index) => ({
          companyId: companyA,
          actorType: Schemas.ActivityLogActorTypeIntEnum.System,
          entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
          entityId: undoneId,
          entityAction: Schemas.ChangeRequestEntityActionEnum.Committing,
          detail: {},
          createdAt: new Date(base + index * 1000),
        })),
        {
          companyId: companyA,
          actorType: Schemas.ActivityLogActorTypeIntEnum.System,
          entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
          entityId: undoneId,
          entityAction: Schemas.ChangeRequestEntityActionEnum.Undone,
          detail: {},
          createdAt: new Date(base + (max + 10) * 1000),
        },
      ]),
    );
    const { body } = await call<Schemas.GetChangeRequestApiResponse>(
      "GET",
      `/dashboard/change-requests/${undone}`,
      { as: adminA },
    );
    const { timeline } = body.changeRequest!;
    expect(timeline).toHaveLength(max);
    expect(timeline.at(-1)!.label).toBe("Changes undone");
    // DEV_NOTE: Oldest first within what's kept: the first 6 attempts are the ones left out
    expect(timeline[0]!.createdAt).toBe(new Date(base + 6_000).toISOString());
  });

  it("shows a change with no events with an empty timeline", async () => {
    const { body } = await call<Schemas.GetChangeRequestApiResponse>(
      "GET",
      `/dashboard/change-requests/${verified}`,
      { as: adminA },
    );
    expect(body.changeRequest!.timeline).toEqual([]);
  });
});

describe("GET /dashboard/change-requests/needs-human-count", () => {
  it("counts the company's changes that need a person", async () => {
    const before = await call<Schemas.GetChangeRequestsNeedsHumanCountApiResponse>(
      "GET",
      "/dashboard/change-requests/needs-human-count",
      { as: adminB },
    );
    expect(before.status).toBe(200);
    expect(before.body.needsHumanCount).toBe(1);
    expect(
      (await call("GET", "/dashboard/change-requests/needs-human-count", { as: operator })).status,
    ).toBe(403);
  });
});

describe("POST /dashboard/change-requests/:publicId/resolve", () => {
  const countNeedsHuman = async () =>
    (
      await call<Schemas.GetChangeRequestsNeedsHumanCountApiResponse>(
        "GET",
        "/dashboard/change-requests/needs-human-count",
        { as: adminA },
      )
    ).body.needsHumanCount;

  it("refuses another company's change with 404, an unknown one with 404 and an operator with 403", async () => {
    const path = `/dashboard/change-requests/${needsHuman}/resolve`;
    expect((await call("POST", path, { as: adminB })).status).toBe(404);
    expect(
      (await call("POST", "/dashboard/change-requests/nope/resolve", { as: adminA })).status,
    ).toBe(404);
    expect((await call("POST", path, { as: operator })).status).toBe(403);
    expect((await call("POST", path)).status).toBe(401);
  });

  it("resolves a change that needs a person, with its event, and its values go to the purge (Done when)", async () => {
    expect(await countNeedsHuman()).toBe(2);
    const startedAt = Date.now();
    const { status, body, text } = await call<Schemas.ResolveChangeRequestApiResponse>(
      "POST",
      `/dashboard/change-requests/${needsHuman}/resolve`,
      { as: adminA },
    );
    expect(status).toBe(200);
    expect(body.changeRequest).toMatchObject({
      publicId: needsHuman,
      changeRequestStatus: Resolved,
      changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.Resolved,
      errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
    });
    expect(body.changeRequest!.timeline.at(-1)!.label).toBe("Marked resolved by Ana Ruiz");
    expect(text).not.toMatch(/"outboxId"/);

    await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.id, needsHumanId));
      expect(row!.status).toBe(Resolved);
      // DEV_NOTE: undo_until = now: the next purge run empties its values (the purge itself is M3-7's, tested there)
      expect(row!.undoUntil!.getTime()).toBeGreaterThanOrEqual(startedAt - 1_000);
      expect(row!.undoUntil!.getTime()).toBeLessThanOrEqual(Date.now());
      const eventConditions = [
        eq(activityLog.companyId, companyA),
        eq(activityLog.entityId, needsHumanId),
        eq(activityLog.entityAction, Schemas.ChangeRequestEntityActionEnum.Resolved),
      ];
      const events = await ownerDb
        .select()
        .from(activityLog)
        .where(and(...eventConditions));
      expect(events).toHaveLength(1);
      expect(events[0]!.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.Admin);
      expect(events[0]!.actorId).toBe(adminAId);
      const outboxConditions = [
        eq(eventOutbox.companyId, companyA),
        eq(eventOutbox.activityLogId, events[0]!.id),
      ];
      const outbox = await ownerDb
        .select()
        .from(eventOutbox)
        .where(and(...outboxConditions));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.eventType).toBe(
        Schemas.changeRequestEventType(Schemas.ChangeRequestEntityActionEnum.Resolved),
      );
      expect(outbox[0]!.dedupeKey).toBe(
        Schemas.changeRequestEventDedupeKey(
          Schemas.ChangeRequestEntityActionEnum.Resolved,
          needsHuman,
        ),
      );
    });

    expect(await countNeedsHuman()).toBe(1);
    const needsTab = await list(`tab=${Tab.NeedsHuman}`);
    expect(needsTab.body.changeRequests!.map((row) => row.publicId)).toEqual([raced]);
    // DEV_NOTE: Resolved shows only under All
    expect((await list()).body.changeRequests!.map((row) => row.publicId)).toContain(needsHuman);
  });

  it("refuses with 409 a change that doesn't need a person, resolved ones included, and writes nothing", async () => {
    for (const publicId of [needsHuman, verified, proposed]) {
      const { status, body } = await call<Schemas.ResolveChangeRequestApiResponse>(
        "POST",
        `/dashboard/change-requests/${publicId}/resolve`,
        { as: adminA },
      );
      expect(status).toBe(409);
      expect(body.failure).toBe(Schemas.ChangeRequestResolveFailureEnum.NotNeedsHuman);
    }
    const events = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyA),
            eq(activityLog.entityAction, Schemas.ChangeRequestEntityActionEnum.Resolved),
          ),
        ),
    );
    expect(events).toHaveLength(1);
  });

  it("resolves once when two admins resolve at the same time (the row lock)", async () => {
    const path = `/dashboard/change-requests/${raced}/resolve`;
    const answers = await Promise.all([
      call("POST", path, { as: adminA }),
      call("POST", path, { as: adminA }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(await countNeedsHuman()).toBe(0);
  });

  it("keeps a resolve that committed when only its answer's timeline fails to load", async () => {
    const publicId = await withOwnerDb(async (ownerDb) => {
      const [toolCall] = await ownerDb
        .insert(toolCalls)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId: priyaConversationId,
          turnId: Utility.generateUlid(START + 9 * 60 * 1000),
          toolId: toolAId,
          toolVersion: 3,
          status: Schemas.ToolCallStatusIntEnum.Ok,
        })
        .returning({ id: toolCalls.id });
      const [row] = await ownerDb
        .insert(changeRequests)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          conversationId: priyaConversationId,
          toolCallId: toolCall!.id,
          status: NeedsHuman,
          summary: "Close EXT-B-021",
          changeCount: 1,
          errorCode: Schemas.ChangeRequestErrorCodeEnum.VerifyUnknown,
        })
        .returning({ publicId: changeRequests.publicId });
      return row!.publicId;
    });
    const timelineRead = vi
      .spyOn(ActivityLogDAL.prototype, "getActivityLogTimeline")
      .mockResolvedValue({ isSuccess: false, message: "Timeline unavailable" });
    try {
      const { status, body } = await call<Schemas.ResolveChangeRequestApiResponse>(
        "POST",
        `/dashboard/change-requests/${publicId}/resolve`,
        { as: adminA },
      );
      expect(status).toBe(200);
      expect(body.changeRequest).toMatchObject({ changeRequestStatus: Resolved, timeline: [] });
    } finally {
      timelineRead.mockRestore();
    }
    const [row] = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ status: changeRequests.status })
        .from(changeRequests)
        .where(eq(changeRequests.publicId, publicId)),
    );
    expect(row!.status).toBe(Resolved);
  });
});
