import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  changeRequests,
  chatbotUsers,
  chatbots,
  companies,
  companyConnections,
  companyEncryptionKeys,
  conversations,
  eventOutbox,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import HostToolCallProvider from "@/providers/hostToolCall";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ActionEngineRepo from "@/repositories/ActionEngineRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import Utility from "@/utils/Utility";
import {
  mintTestHostTokens,
  newTestHostWorkspace,
  resetTestHost,
  routeTestHostFetch,
  testHostIssuer,
  testHostToolColumns,
} from "@/tests/helpers/testHost";
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

// DEV_NOTE: ActionEngineRepo on the Neon staging branch (M3-4), run as diletta_app (HYPERDRIVE), so RLS applies; the
// commit goes through HostToolCallProvider to the real test host. Two companies, each created through CompaniesRepo
// (company key) with a connection to the test host, a chatbot, a chatbot user, an open conversation and the test host's
// tools (update_record Active, get_record Disabled). Fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let ownerPool: Pool | null = null;
let sessionA: Schemas.ConversationSession;
// DEV_NOTE: Fixtures a single test creates, cleaned up with A and B
const extraSessions: Schemas.ConversationSession[] = [];
let sessionB: Schemas.ConversationSession;
let hostToken = "";
let hostWorkspace = "";
// DEV_NOTE: Each fixture conversation's conversation.started root log, which every change request event hangs under
const rootLogIds = new Map<string, string>();

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

async function createFixture(label: string): Promise<Schemas.ConversationSession> {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Action engine ${label} ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(created.message);
  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, created.company?.publicId ?? ""));
    const companyId = company?.id ?? "";
    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId, name: "Bot", isDefault: true })
      .returning();
    const [connection] = await ownerDb
      .insert(companyConnections)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: Schemas.getTestHostBaseUrl(testHostIssuer),
        authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
        allowedOrigins: ["https://app.example.com"],
      })
      .returning();
    await ownerDb.insert(toolDefinitions).values([
      {
        publicId: Utility.generatePublicId(),
        companyId,
        connectionId: connection?.id ?? "",
        version: 1,
        status: Schemas.ToolDefinitionStatusIntEnum.Active,
        ...testHostToolColumns("update_record"),
      },
      {
        publicId: Utility.generatePublicId(),
        companyId,
        connectionId: connection?.id ?? "",
        version: 1,
        status: Schemas.ToolDefinitionStatusIntEnum.Disabled,
        ...testHostToolColumns("get_record"),
      },
    ]);
    const [chatbotUser] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId, hostUserId: `user-${crypto.randomUUID()}` })
      .returning();
    const [rootLog] = await ownerDb
      .insert(activityLog)
      .values({
        companyId,
        actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
        actorId: chatbotUser?.id ?? null,
        entityType: "conversation",
        entityAction: "started",
      })
      .returning({ id: activityLog.id });
    const [conversation] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        chatbotUserId: chatbotUser?.id ?? "",
        chatbotId: chatbot?.id ?? "",
        rootLogId: rootLog?.id ?? null,
      })
      .returning();
    rootLogIds.set(conversation?.id ?? "", rootLog?.id ?? "");
    return {
      companyId,
      chatbotId: chatbot?.id ?? "",
      chatbotPublicId: chatbot?.publicId ?? "",
      chatbotName: "Bot",
      chatbotUserId: chatbotUser?.id ?? "",
      conversationId: conversation?.id ?? "",
      conversationPublicId: conversation?.publicId ?? "",
    };
  });
}

async function loadUpdateTool(session: Schemas.ConversationSession) {
  const loaded = await new ActionEngineRepo(env).loadTurnTools({
    session,
    pins: [{ name: "update_record", version: 1 }],
    isReadOnly: false,
  });
  const tool = loaded.tools?.[0];
  if (!tool?.ops.readbackOp) throw new Error("update_record not loaded");
  return tool;
}

async function propose(
  session: Schemas.ConversationSession,
  amount: number,
  isApprovalRequired = true,
  before: unknown = { data: { id: "rec_alpha", amount: 120 } },
) {
  const tool = await loadUpdateTool(session);
  const args = { recordId: "rec_alpha", amount };
  const kind = Schemas.ChangeRequestKindEnum.Update;
  const proposed = await new ActionEngineRepo(env).proposeChange({
    session,
    turnId: Utility.generateUlid(),
    tool,
    args,
    kind,
    before,
    changes: Schemas.buildChangeRequestChanges({
      kind,
      callOp: tool.ops.callOp,
      readbackOp: tool.ops.readbackOp!,
      args,
      before,
    }),
    isApprovalRequired,
    hasUntrustedContext: true,
    latencyMs: 5,
  });
  if (!proposed.changeRequest) throw new Error(proposed.message);
  return proposed;
}

async function eventsOf(changeRequestPublicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ id: changeRequests.id })
      .from(changeRequests)
      .where(eq(changeRequests.publicId, changeRequestPublicId));
    return await ownerDb
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
          eq(activityLog.entityId, row?.id ?? ""),
        ),
      )
      .orderBy(asc(activityLog.id));
  });
}

const startCommit = (session: Schemas.ConversationSession, changeRequestPublicId: string) =>
  new ActionEngineRepo(env).startCommit({
    session,
    changeRequestPublicId,
    attemptId: Utility.generateUlid(),
  });

// DEV_NOTE: A commit plan for a change request that isn't the caller's (cross-company): the step must refuse it first
async function forgedPlan(changeRequestPublicId: string): Promise<Schemas.CommitPlan> {
  return {
    changeRequestPublicId,
    tool: await loadUpdateTool(sessionA),
    payload: {
      version: 2,
      kind: Schemas.ChangeRequestKindEnum.Update,
      args: { recordId: "rec_alpha", amount: 1 },
      before: null,
      changes: [],
      result: null,
      mismatches: null,
    },
    idempotencyKey: Schemas.changeRequestCommitIdempotencyKey(changeRequestPublicId),
    isResume: false,
  };
}

// DEV_NOTE: An approved change to rec_alpha, proposed from the real read-before and committed against the test host:
// the read-after plan finishCommit hands back (M3-6)
async function commitAlpha(session: Schemas.ConversationSession, amount: number) {
  routeTestHostFetch();
  const repo = new ActionEngineRepo(env);
  const tool = await loadUpdateTool(session);
  const read = await HostToolCallProvider.readBefore({
    tool,
    args: { recordId: "rec_alpha" },
    getHostToken: () => hostToken,
  });
  const publicId = (await propose(session, amount, false, read.body)).changeRequest!.publicId;
  const started = await startCommit(session, publicId);
  const committed = await HostToolCallProvider.commit({
    plan: started.plan!,
    getHostToken: () => hostToken,
  });
  const finished = await repo.finishCommit({
    session,
    changeRequestPublicId: publicId,
    hostCall: committed,
    plan: started.plan!,
  });
  if (!finished.followUp) throw new Error(`${finished.message}: ${committed.outcome}`);
  return { publicId, followUp: finished.followUp };
}

const readAlpha = async () =>
  (
    await HostToolCallProvider.readAfter({
      plan: {
        tool: await loadUpdateTool(sessionA),
        payload: (await forgedPlan("x")).payload,
      },
      getHostToken: () => hostToken,
    })
  ).body as { data?: Record<string, unknown> } | undefined;

// DEV_NOTE: Moves a proposal's created_at back, so its approval deadline has passed
const ageChangeRequest = (publicId: string, ageMs: number) =>
  withOwnerDb((ownerDb) =>
    ownerDb
      .update(changeRequests)
      .set({ createdAt: new Date(Date.now() - ageMs) })
      .where(eq(changeRequests.publicId, publicId)),
  );

const setToolStatus = (companyId: string, status: Schemas.ToolDefinitionStatusIntEnum) =>
  withOwnerDb((ownerDb) =>
    ownerDb
      .update(toolDefinitions)
      .set({ status })
      .where(
        and(eq(toolDefinitions.companyId, companyId), eq(toolDefinitions.name, "update_record")),
      ),
  );

async function getRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    return row;
  });
}

const setReadOnly = (companyId: string, isReadOnly: boolean) =>
  withOwnerDb((ownerDb) =>
    ownerDb.update(companies).set({ isReadOnly }).where(eq(companies.id, companyId)),
  );

beforeAll(async () => {
  sessionA = await createFixture("A");
  sessionB = await createFixture("B");
  hostWorkspace = newTestHostWorkspace();
  hostToken = (await mintTestHostTokens(hostWorkspace)).hostToken;
  await resetTestHost(hostToken);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const companyIds = [
    sessionA?.companyId,
    sessionB?.companyId,
    ...extraSessions.map((session) => session.companyId),
  ].filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
      await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
      await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
      await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
      await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
      await ownerDb
        .delete(companyConnections)
        .where(inArray(companyConnections.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb
        .delete(companyEncryptionKeys)
        .where(inArray(companyEncryptionKeys.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

describe("ActionEngineRepo.loadTurnTools", () => {
  it("loads the exact Active pins and leaves out a Disabled or missing version", async () => {
    const loaded = await new ActionEngineRepo(env).loadTurnTools({
      session: sessionA,
      pins: [
        { name: "update_record", version: 1 },
        { name: "get_record", version: 1 },
        { name: "update_record", version: 9 },
      ],
      isReadOnly: false,
    });
    expect(loaded.isSuccess).toBe(true);
    expect(loaded.tools?.map((tool) => [tool.name, tool.version])).toEqual([["update_record", 1]]);
    expect(loaded.skippedCount).toBe(2);
    expect(loaded.tools?.[0]?.connection.baseUrl).toBe(Schemas.getTestHostBaseUrl(testHostIssuer));
  });

  it("leaves out a tool whose connection is no longer Active", async () => {
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(companyConnections)
        .set({ status: Schemas.CompanyConnectionStatusIntEnum.Disabled })
        .where(eq(companyConnections.companyId, sessionB.companyId)),
    );
    try {
      const loaded = await new ActionEngineRepo(env).loadTurnTools({
        session: sessionB,
        pins: [{ name: "update_record", version: 1 }],
        isReadOnly: false,
      });
      expect(loaded.tools).toEqual([]);
    } finally {
      await withOwnerDb((ownerDb) =>
        ownerDb
          .update(companyConnections)
          .set({ status: Schemas.CompanyConnectionStatusIntEnum.Active })
          .where(eq(companyConnections.companyId, sessionB.companyId)),
      );
    }
  });

  it("loads no write tool for a read-only company, without counting it as left out", async () => {
    const loaded = await new ActionEngineRepo(env).loadTurnTools({
      session: sessionA,
      pins: [{ name: "update_record", version: 1 }],
      isReadOnly: true,
    });
    expect(loaded.tools).toEqual([]);
    expect(loaded.skippedCount).toBe(0);
  });
});

describe("ActionEngineRepo change requests", () => {
  it("proposes, approves and commits a change against the test host, one event per status", async () => {
    routeTestHostFetch();
    const repo = new ActionEngineRepo(env);
    const proposed = await propose(sessionA, 333);
    const publicId = proposed.changeRequest!.publicId;
    expect(proposed.changeRequest).toMatchObject({
      changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Proposed,
      changeCount: 1,
      toolName: "update_record",
    });
    expect(proposed.outboxIds).toHaveLength(1);

    // DEV_NOTE: The payload is encrypted at rest, and the view decrypts it for the conversation's own DO
    const stored = await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.publicId, publicId));
      return row;
    });
    expect(Buffer.from(stored?.encryptedChanges ?? []).toString("utf8")).not.toContain("333");
    const views = await repo.getChangeRequestViews({
      session: sessionA,
      changeRequestPublicIds: [publicId],
    });
    expect(views.changeRequests?.[0]?.changes?.[0]?.after).toEqual({ isFound: true, value: 333 });

    const approved = await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Approve,
      isExpired: false,
    });
    expect(approved.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Approved,
    );
    const again = await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Reject,
      isExpired: false,
    });
    expect(again.failure).toBe(Schemas.ChangeRequestFailureEnum.InvalidTransition);

    const started = await startCommit(sessionA, publicId);
    expect(started.plan).toMatchObject({
      isResume: false,
      idempotencyKey: Schemas.changeRequestCommitIdempotencyKey(publicId),
    });
    expect(started.plan?.payload.args).toEqual({ recordId: "rec_alpha", amount: 333 });
    const committed = await HostToolCallProvider.commit({
      plan: started.plan!,
      getHostToken: () => hostToken,
    });
    expect(committed.outcome).toBe(Schemas.HostCallOutcomeEnum.Succeeded);
    const finished = await repo.finishCommit({
      session: sessionA,
      changeRequestPublicId: publicId,
      hostCall: committed,
      plan: started.plan!,
    });
    expect(finished.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Committed,
    );

    const events = await eventsOf(publicId);
    expect(events.map((event) => event.entityAction)).toEqual([
      "proposed",
      "approved",
      "committing",
      "committed",
    ]);
    const rootLogId = rootLogIds.get(sessionA.conversationId);
    expect(
      events.every((event) => event.rootLogId === rootLogId && event.parentLogId === rootLogId),
    ).toBe(true);
    expect(JSON.stringify(events.map((event) => event.detail))).not.toContain("333");
  });

  it("resumes a commit an eviction cut short, and never ends one that may have landed as Failed", async () => {
    const repo = new ActionEngineRepo(env);
    const proposed = await propose(sessionA, 444, false);
    const publicId = proposed.changeRequest!.publicId;
    expect(proposed.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Approved,
    );
    expect(proposed.outboxIds).toHaveLength(2);

    const first = await startCommit(sessionA, publicId);
    expect(first.plan?.isResume).toBe(false);
    const resumed = await startCommit(sessionA, publicId);
    expect(resumed.plan?.isResume).toBe(true);
    const resumedAgain = await startCommit(sessionA, publicId);
    expect(resumedAgain.plan?.isResume).toBe(true);
    // DEV_NOTE: Every attempt is on the timeline (its own attempt id), none deduped into another
    const committing = (await eventsOf(publicId)).filter(
      (event) => event.entityAction === "committing",
    );
    expect(committing).toHaveLength(3);

    const finished = await repo.finishCommit({
      session: sessionA,
      changeRequestPublicId: publicId,
      hostCall: { outcome: Schemas.HostCallOutcomeEnum.Failed, mayHaveLanded: false, attempts: 0 },
      plan: resumedAgain.plan!,
    });
    expect(finished.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
    );
  });

  it.each([
    [Schemas.HostCallOutcomeEnum.Unknown, true, Schemas.ChangeRequestStatusIntEnum.NeedsHuman],
    [Schemas.HostCallOutcomeEnum.Refused, false, Schemas.ChangeRequestStatusIntEnum.Failed],
    [
      Schemas.HostCallOutcomeEnum.TokenRejected,
      true,
      Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
    ],
    [
      Schemas.HostCallOutcomeEnum.AlreadyApplied,
      true,
      Schemas.ChangeRequestStatusIntEnum.Committed,
    ],
  ])(
    "ends a commit whose host call was %s (may have landed: %s) as status %i",
    async (outcome, mayHaveLanded, status) => {
      const repo = new ActionEngineRepo(env);
      const proposed = await propose(sessionA, 10, false);
      const publicId = proposed.changeRequest!.publicId;
      const started = await startCommit(sessionA, publicId);
      const finished = await repo.finishCommit({
        session: sessionA,
        changeRequestPublicId: publicId,
        hostCall: { outcome, mayHaveLanded, attempts: 1 },
        plan: started.plan!,
      });
      expect(finished.changeRequest?.changeRequestStatus).toBe(status);
    },
  );

  it("expires a proposal as the system, and refuses to approve it afterwards", async () => {
    const repo = new ActionEngineRepo(env);
    const publicId = (await propose(sessionA, 11)).changeRequest!.publicId;
    const expired = await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Reject,
      isExpired: true,
    });
    expect(expired.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Expired,
    );
    expect((await eventsOf(publicId)).at(-1)?.actorType).toBe(
      Schemas.ActivityLogActorTypeIntEnum.System,
    );
    const approved = await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Approve,
      isExpired: false,
    });
    expect(approved.failure).toBe(Schemas.ChangeRequestFailureEnum.InvalidTransition);
    expect(approved.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Expired,
    );
  });

  it("ends an approval that comes after the deadline as Expired, by the system", async () => {
    const repo = new ActionEngineRepo(env);
    const publicId = (await propose(sessionA, 14)).changeRequest!.publicId;
    await ageChangeRequest(publicId, Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS + 1_000);
    const late = await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Approve,
      isExpired: false,
    });
    expect(late.isSuccess).toBe(true);
    expect(late.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Expired,
    );
    expect(late.changeRequest?.expiresAt).toBeNull();
    expect((await eventsOf(publicId)).at(-1)).toMatchObject({
      entityAction: "expired",
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
    });
    expect((await startCommit(sessionA, publicId)).failure).toBe(
      Schemas.ChangeRequestFailureEnum.InvalidTransition,
    );
  });

  it("names a rolled-back step a ServerError, so the DO retries it rather than dropping it", async () => {
    const publicId = (await propose(sessionA, 15, false)).changeRequest!.publicId;
    // DEV_NOTE: The status write fails inside the transaction: withTenant rolls back and returns no failure of its own
    vi.spyOn(ChangeRequestsDAL.prototype, "updateChangeRequestStatus").mockResolvedValueOnce({
      isSuccess: false,
      message: "Unknown error in updating change request status",
    });
    const started = await startCommit(sessionA, publicId);
    expect(started.isSuccess).toBe(false);
    expect(started.failure).toBe(Schemas.ChangeRequestFailureEnum.ServerError);
    expect(started.plan).toBeUndefined();
    expect((await getRow(publicId))?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Approved);
    expect((await startCommit(sessionA, publicId)).plan?.isResume).toBe(false);
  });

  it("ends a commit whose tool was disabled after approval as Failed, with the reason stored", async () => {
    const repo = new ActionEngineRepo(env);
    const publicId = (await propose(sessionB, 16, false)).changeRequest!.publicId;
    await setToolStatus(sessionB.companyId, Schemas.ToolDefinitionStatusIntEnum.Disabled);
    try {
      const started = await startCommit(sessionB, publicId);
      expect(started.failure).toBe(Schemas.ChangeRequestFailureEnum.ToolUnavailable);
      expect(started.changeRequest?.changeRequestStatus).toBe(
        Schemas.ChangeRequestStatusIntEnum.Failed,
      );
      expect((await getRow(publicId))?.errorCode).toBe(
        Schemas.ChangeRequestErrorCodeEnum.ToolUnavailable,
      );
    } finally {
      await setToolStatus(sessionB.companyId, Schemas.ToolDefinitionStatusIntEnum.Active);
    }
    // DEV_NOTE: A purged payload: the view has no changes, and an update's kind is unknown without it
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(changeRequests)
        .set({ encryptedChanges: null, iv: null, encryptionKeyVersion: null })
        .where(eq(changeRequests.publicId, publicId)),
    );
    const views = await repo.getChangeRequestViews({
      session: sessionB,
      changeRequestPublicIds: [publicId],
    });
    expect(views.changeRequests?.[0]).toMatchObject({ changes: null, kind: null });
  });

  it("refuses to propose or approve for a read-only company, but still lets the user reject", async () => {
    const repo = new ActionEngineRepo(env);
    const publicId = (await propose(sessionA, 12)).changeRequest!.publicId;
    await setReadOnly(sessionA.companyId, true);
    try {
      const tool = await loadUpdateTool(sessionA);
      const refused = await repo.proposeChange({
        session: sessionA,
        turnId: Utility.generateUlid(),
        tool,
        args: { recordId: "rec_alpha", amount: 13 },
        kind: Schemas.ChangeRequestKindEnum.Update,
        before: null,
        changes: [],
        isApprovalRequired: true,
        hasUntrustedContext: false,
        latencyMs: 1,
      });
      expect(refused.failure).toBe(Schemas.ChangeRequestFailureEnum.ReadOnly);
      const approved = await repo.decideChangeRequest({
        session: sessionA,
        changeRequestPublicId: publicId,
        decision: Schemas.ChangeRequestDecisionEnum.Approve,
        isExpired: false,
      });
      expect(approved.failure).toBe(Schemas.ChangeRequestFailureEnum.ReadOnly);
      const rejected = await repo.decideChangeRequest({
        session: sessionA,
        changeRequestPublicId: publicId,
        decision: Schemas.ChangeRequestDecisionEnum.Reject,
        isExpired: false,
      });
      expect(rejected.changeRequest?.changeRequestStatus).toBe(
        Schemas.ChangeRequestStatusIntEnum.Rejected,
      );
    } finally {
      await setReadOnly(sessionA.companyId, false);
    }
  });
});

// DEV_NOTE: An edited payload as the DO builds it (M3-5): the plan's args with a new amount, the diff rebuilt
function editedPayload(plan: Schemas.EditPlan, amount: number): Schemas.ChangeRequestPayload {
  const args = { ...plan.payload.args, amount };
  const before = { data: { id: "rec_alpha", amount: 120 } };
  return {
    version: 2,
    kind: plan.payload.kind,
    args,
    before,
    result: null,
    mismatches: null,
    changes: Schemas.buildChangeRequestChanges({
      kind: plan.payload.kind,
      callOp: plan.tool.ops.callOp,
      readbackOp: plan.tool.ops.readbackOp!,
      args,
      before,
    }),
  };
}

describe("ActionEngineRepo read-after and auto-undo (M3-6)", { timeout: 90_000 }, () => {
  // DEV_NOTE: The host token lives minutes; the whole file runs longer, so these get a fresh one
  beforeEach(async () => {
    hostToken = (await mintTestHostTokens(hostWorkspace)).hostToken;
  });

  it("reads a landed commit back: Verified, its result kept, one event per step", async () => {
    const repo = new ActionEngineRepo(env);
    const { publicId, followUp } = await commitAlpha(sessionA, 410);
    expect(followUp).toMatchObject({
      followUp: Schemas.ChangeRequestFollowUpEnum.Verify,
      idempotencyKey: null,
      isResume: false,
    });
    expect(followUp.payload.result).toMatchObject({ data: { id: "rec_alpha", amount: 410 } });

    const read = await HostToolCallProvider.readAfter({
      plan: followUp,
      getHostToken: () => hostToken,
    });
    const verified = await repo.finishVerify({
      session: sessionA,
      changeRequestPublicId: publicId,
      plan: followUp,
      readback: read,
    });
    expect(verified.followUp).toBeUndefined();
    expect(verified.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Verified,
    );
    expect(verified.changeRequest?.mismatches).toBeNull();

    const row = await getRow(publicId);
    expect(row?.hostRef).toBeNull();
    expect(row?.errorCode).toBeNull();
    expect(Buffer.from(row?.encryptedChanges ?? []).toString("utf8")).not.toContain("410");
    const events = await eventsOf(publicId);
    expect(events.map((event) => event.entityAction)).toEqual([
      "proposed",
      "approved",
      "committing",
      "committed",
      "verified",
    ]);
    expect(JSON.stringify(events.map((event) => event.detail))).not.toContain("410");
  });

  it("starts the auto-undo of a mismatch in the same step, resumes it, and ends Undone once it reads back", async () => {
    const repo = new ActionEngineRepo(env);
    const { publicId, followUp } = await commitAlpha(sessionA, 420);
    // DEV_NOTE: A concurrent edit on the host: the record reads back 999, not the 420 the commit set
    const overwritten = {
      outcome: Schemas.HostCallOutcomeEnum.Succeeded,
      httpStatus: 200,
      body: { data: { id: "rec_alpha", amount: 999 } },
      attempts: 1,
    };
    const mismatched = await repo.finishVerify({
      session: sessionA,
      changeRequestPublicId: publicId,
      plan: followUp,
      readback: overwritten,
    });
    expect(mismatched.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Mismatch,
    );
    expect(mismatched.changeRequest?.mismatches).toEqual([
      {
        field: "amount",
        expected: { isFound: true, value: 420 },
        found: { isFound: true, value: 999 },
      },
    ]);
    expect(mismatched.followUp).toMatchObject({
      followUp: Schemas.ChangeRequestFollowUpEnum.Undo,
      idempotencyKey: Schemas.changeRequestUndoIdempotencyKey(publicId),
      isResume: false,
    });
    expect((await getRow(publicId))?.idempotencyKey).toBe(
      Schemas.changeRequestUndoIdempotencyKey(publicId),
    );

    // DEV_NOTE: An eviction before the undo's end: the stored key makes the next attempt a resume
    const resumed = await repo.startFollowUp({
      session: sessionA,
      changeRequestPublicId: publicId,
      attemptId: Utility.generateUlid(),
    });
    expect(resumed.followUp).toMatchObject({
      followUp: Schemas.ChangeRequestFollowUpEnum.Undo,
      isResume: true,
    });
    expect(resumed.followUp?.payload.mismatches).toHaveLength(1);

    const undo = await HostToolCallProvider.undo({
      plan: resumed.followUp!,
      getHostToken: () => hostToken,
    });
    expect([
      Schemas.HostCallOutcomeEnum.Succeeded,
      Schemas.HostCallOutcomeEnum.AlreadyApplied,
    ]).toContain(undo.outcome);
    const reread = await HostToolCallProvider.readAfter({
      plan: resumed.followUp!,
      getHostToken: () => hostToken,
    });
    const undone = await repo.finishUndo({
      session: sessionA,
      changeRequestPublicId: publicId,
      plan: resumed.followUp!,
      undo,
      readback: reread,
    });
    expect(undone.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Undone,
    );
    expect((await readAlpha())?.data?.amount).toBe(
      (followUp.payload.before as { data: { amount: number } }).data.amount,
    );
    expect((await eventsOf(publicId)).map((event) => event.entityAction)).toEqual([
      "proposed",
      "approved",
      "committing",
      "committed",
      "mismatch",
      "undoing",
      "undoing",
      "undone",
    ]);
  });

  it("ends a mismatch NeedsHuman when the tool can't be undone, and a read-after that can't tell too", async () => {
    const repo = new ActionEngineRepo(env);
    const first = await commitAlpha(sessionA, 430);
    const notUndoable: Schemas.FollowUpPlan = {
      ...first.followUp,
      tool: { ...first.followUp.tool, ops: { ...first.followUp.tool.ops, inverseOp: null } },
    };
    const ended = await repo.finishVerify({
      session: sessionA,
      changeRequestPublicId: first.publicId,
      plan: notUndoable,
      readback: {
        outcome: Schemas.HostCallOutcomeEnum.Succeeded,
        httpStatus: 200,
        body: { data: { id: "rec_alpha", amount: 1 } },
        attempts: 1,
      },
    });
    expect(ended.followUp).toBeUndefined();
    expect(ended.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
    );
    expect((await getRow(first.publicId))?.errorCode).toBe(
      Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
    );

    // DEV_NOTE: The host didn't answer the read-after: a person checks, nothing is undone on a guess
    const second = await commitAlpha(sessionA, 440);
    const unknown = await repo.finishVerify({
      session: sessionA,
      changeRequestPublicId: second.publicId,
      plan: second.followUp,
      readback: { outcome: Schemas.HostCallOutcomeEnum.Failed, attempts: 3 },
    });
    expect(unknown.followUp).toBeUndefined();
    expect(unknown.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
    );
    expect((await getRow(second.publicId))?.errorCode).toBe(
      Schemas.ChangeRequestErrorCodeEnum.VerifyUnknown,
    );
    expect((await readAlpha())?.data?.amount).toBe(440);
  });

  it("ends an undo that didn't succeed NeedsHuman, and resumes a commit's read-after from the row", async () => {
    const repo = new ActionEngineRepo(env);
    const { publicId, followUp } = await commitAlpha(sessionA, 450);

    // DEV_NOTE: An eviction between the commit's end and the read-after: the row says what comes next
    const resumed = await repo.startFollowUp({
      session: sessionA,
      changeRequestPublicId: publicId,
      attemptId: Utility.generateUlid(),
    });
    expect(resumed.followUp?.followUp).toBe(Schemas.ChangeRequestFollowUpEnum.Verify);
    expect(resumed.followUp?.payload.result).toEqual(followUp.payload.result);

    const mismatched = await repo.finishVerify({
      session: sessionA,
      changeRequestPublicId: publicId,
      plan: resumed.followUp!,
      readback: {
        outcome: Schemas.HostCallOutcomeEnum.Succeeded,
        httpStatus: 200,
        body: { data: { id: "rec_alpha", amount: 2 } },
        attempts: 1,
      },
    });
    const failed = await repo.finishUndo({
      session: sessionA,
      changeRequestPublicId: publicId,
      plan: mismatched.followUp!,
      undo: { outcome: Schemas.HostCallOutcomeEnum.Unknown, mayHaveLanded: true, attempts: 3 },
      readback: null,
    });
    expect(failed.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
    );
    expect((await getRow(publicId))?.errorCode).toBe(Schemas.ChangeRequestErrorCodeEnum.UndoFailed);

    // DEV_NOTE: Settled: no step takes it up again
    const again = await repo.startFollowUp({
      session: sessionA,
      changeRequestPublicId: publicId,
      attemptId: Utility.generateUlid(),
    });
    expect(again.failure).toBe(Schemas.ChangeRequestFailureEnum.InvalidTransition);
  });
});

describe("ActionEngineRepo edits (M3-5)", () => {
  it("edits a Proposed change request: new payload encrypted, was_edited, an edited event by the user", async () => {
    const repo = new ActionEngineRepo(env);
    const proposed = (await propose(sessionA, 31)).changeRequest!;
    expect(proposed.editableFields.map((field) => field.field)).toContain("amount");
    expect(proposed.editableFields.map((field) => field.field)).not.toContain("recordId");

    const planned = await repo.getEditPlan({
      session: sessionA,
      changeRequestPublicId: proposed.publicId,
    });
    expect(planned.isSuccess).toBe(true);
    expect(planned.plan?.payload.args).toEqual({ recordId: "rec_alpha", amount: 31 });

    const saved = await repo.saveEdit({
      session: sessionA,
      changeRequestPublicId: proposed.publicId,
      payload: editedPayload(planned.plan!, 99),
      editId: Utility.generateUlid(),
    });
    expect(saved.isSuccess).toBe(true);
    expect(saved.changeRequest).toMatchObject({
      changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Proposed,
      wasEdited: true,
    });
    expect(saved.changeRequest?.changes?.[0]?.after).toEqual({ isFound: true, value: 99 });
    const row = await getRow(proposed.publicId);
    expect(row?.wasEdited).toBe(true);
    expect(Buffer.from(row?.encryptedChanges ?? []).toString("utf8")).not.toContain("99");
    expect((await eventsOf(proposed.publicId)).at(-1)).toMatchObject({
      entityAction: "edited",
      actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
    });

    // DEV_NOTE: The commit sends the edited args
    await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: proposed.publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Approve,
      isExpired: false,
    });
    expect((await startCommit(sessionA, proposed.publicId)).plan?.payload.args.amount).toBe(99);
  });

  it("refuses an edit once decided or past the deadline, and a payload of another kind", async () => {
    const repo = new ActionEngineRepo(env);
    const decidedId = (await propose(sessionA, 32)).changeRequest!.publicId;
    const plan = (await repo.getEditPlan({ session: sessionA, changeRequestPublicId: decidedId }))
      .plan!;
    const wrongKind = await repo.saveEdit({
      session: sessionA,
      changeRequestPublicId: decidedId,
      payload: { ...editedPayload(plan, 50), kind: Schemas.ChangeRequestKindEnum.Delete },
      editId: Utility.generateUlid(),
    });
    expect(wrongKind.failure).toBe(Schemas.ChangeRequestFailureEnum.InvalidEdit);

    await repo.decideChangeRequest({
      session: sessionA,
      changeRequestPublicId: decidedId,
      decision: Schemas.ChangeRequestDecisionEnum.Reject,
      isExpired: false,
    });
    const afterDecision = await repo.saveEdit({
      session: sessionA,
      changeRequestPublicId: decidedId,
      payload: editedPayload(plan, 50),
      editId: Utility.generateUlid(),
    });
    expect(afterDecision.failure).toBe(Schemas.ChangeRequestFailureEnum.InvalidTransition);
    expect(afterDecision.changeRequest?.editableFields).toEqual([]);

    const lateId = (await propose(sessionA, 33)).changeRequest!.publicId;
    await ageChangeRequest(lateId, Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS + 1_000);
    const late = await repo.getEditPlan({ session: sessionA, changeRequestPublicId: lateId });
    expect(late.failure).toBe(Schemas.ChangeRequestFailureEnum.PastDeadline);
    expect((await getRow(lateId))?.wasEdited).toBe(false);
    expect((await getRow(decidedId))?.wasEdited).toBe(false);
  });

  it("offers no edit once the tool version is disabled", async () => {
    const repo = new ActionEngineRepo(env);
    const fixture = await createFixture("edit-disabled");
    extraSessions.push(fixture);
    const publicId = (await propose(fixture, 34)).changeRequest!.publicId;
    await setToolStatus(fixture.companyId, Schemas.ToolDefinitionStatusIntEnum.Disabled);
    const planned = await repo.getEditPlan({ session: fixture, changeRequestPublicId: publicId });
    expect(planned.failure).toBe(Schemas.ChangeRequestFailureEnum.ToolUnavailable);
    const views = await repo.getChangeRequestViews({
      session: fixture,
      changeRequestPublicIds: [publicId],
    });
    expect(views.changeRequests?.[0]?.editableFields).toEqual([]);
  });
});

describe("ActionEngineRepo cross-company isolation (diletta_app)", () => {
  // DEV_NOTE: Every step is a round trip to the staging branch, and this one tries them all
  it(
    "never lets another company's session read, decide or commit a change request",
    { timeout: 90_000 },
    async () => {
      const repo = new ActionEngineRepo(env);
      const publicId = (await propose(sessionA, 21)).changeRequest!.publicId;

      // DEV_NOTE: Company B's own session, and one that names A's conversation under B's tenant key
      const forged = {
        ...sessionB,
        conversationId: sessionA.conversationId,
        conversationPublicId: sessionA.conversationPublicId,
      };
      for (const session of [sessionB, forged]) {
        const views = await repo.getChangeRequestViews({
          session,
          changeRequestPublicIds: [publicId],
        });
        expect(views.changeRequests ?? []).toEqual([]);
        const decided = await repo.decideChangeRequest({
          session,
          changeRequestPublicId: publicId,
          decision: Schemas.ChangeRequestDecisionEnum.Reject,
          isExpired: false,
        });
        expect(decided.isSuccess).toBe(false);
        expect(decided.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
        const started = await startCommit(session, publicId);
        expect(started.plan).toBeUndefined();
        expect(started.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
        const finished = await repo.finishCommit({
          session,
          changeRequestPublicId: publicId,
          hostCall: { outcome: Schemas.HostCallOutcomeEnum.Succeeded, attempts: 1 },
          plan: await forgedPlan(publicId),
        });
        expect(finished.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
        // DEV_NOTE: Nor its read-after or undo (M3-6)
        const followUpPlan: Schemas.FollowUpPlan = {
          ...(await forgedPlan(publicId)),
          followUp: Schemas.ChangeRequestFollowUpEnum.Verify,
        };
        const followed = await repo.startFollowUp({
          session,
          changeRequestPublicId: publicId,
          attemptId: Utility.generateUlid(),
        });
        expect(followed.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
        const verified = await repo.finishVerify({
          session,
          changeRequestPublicId: publicId,
          plan: followUpPlan,
          readback: { outcome: Schemas.HostCallOutcomeEnum.Succeeded, body: {}, attempts: 1 },
        });
        expect(verified.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
        const undone = await repo.finishUndo({
          session,
          changeRequestPublicId: publicId,
          plan: { ...followUpPlan, followUp: Schemas.ChangeRequestFollowUpEnum.Undo },
          undo: { outcome: Schemas.HostCallOutcomeEnum.Succeeded, attempts: 1 },
          readback: null,
        });
        expect(undone.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
        const executionSet = await repo.setExecutionId({
          session,
          changeRequestPublicId: publicId,
          thinkExecutionId: "forged",
        });
        expect(executionSet.isSuccess).toBe(false);
        expect(executionSet.isNotFound).toBe(true);
        const planned = await repo.getEditPlan({ session, changeRequestPublicId: publicId });
        expect(planned.plan).toBeUndefined();
        expect([
          Schemas.ChangeRequestFailureEnum.NotFound,
          Schemas.ChangeRequestFailureEnum.ConversationClosed,
        ]).toContain(planned.failure);
        const saved = await repo.saveEdit({
          session,
          changeRequestPublicId: publicId,
          payload: {
            version: 2,
            kind: Schemas.ChangeRequestKindEnum.Update,
            args: { recordId: "rec_alpha", amount: 1 },
            before: null,
            changes: [],
            result: null,
            mismatches: null,
          },
          editId: Utility.generateUlid(),
        });
        expect(saved.isSuccess).toBe(false);
        expect(saved.changeRequest).toBeUndefined();
      }

      const stillProposed = await repo.getChangeRequestViews({
        session: sessionA,
        changeRequestPublicIds: [publicId],
      });
      expect(stillProposed.changeRequests?.[0]?.changeRequestStatus).toBe(
        Schemas.ChangeRequestStatusIntEnum.Proposed,
      );
      expect((await getRow(publicId))?.thinkExecutionId).toBeNull();
      expect((await getRow(publicId))?.wasEdited).toBe(false);
    },
  );

  it("never loads another company's tools or records a tool call under its tenant", async () => {
    const repo = new ActionEngineRepo(env);
    const toolA = await loadUpdateTool(sessionA);
    const loaded = await repo.loadTurnTools({
      session: sessionB,
      pins: [{ name: "update_record", version: 1 }],
      isReadOnly: false,
    });
    expect(loaded.tools?.map((tool) => tool.id)).not.toContain(toolA.id);

    // DEV_NOTE: B's tenant key naming A's conversation and A's tool: RLS and the DAL's reference checks refuse it
    const forged = {
      ...sessionB,
      conversationId: sessionA.conversationId,
      conversationPublicId: sessionA.conversationPublicId,
    };
    const recorded = await repo.recordToolCall({
      session: forged,
      turnId: Utility.generateUlid(),
      tool: toolA,
      args: null,
      status: Schemas.ToolCallStatusIntEnum.Error,
      errorCode: Schemas.ToolCallErrorCodeEnum.InvalidArgs,
      latencyMs: null,
      hasUntrustedContext: false,
    });
    expect(recorded.isSuccess).toBe(false);
    const forgedRows = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ id: toolCalls.id })
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.companyId, sessionB.companyId),
            eq(toolCalls.conversationId, sessionA.conversationId),
          ),
        ),
    );
    expect(forgedRows).toEqual([]);
  });
});
