import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
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
let sessionB: Schemas.ConversationSession;
let hostToken = "";
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
) {
  const tool = await loadUpdateTool(session);
  const args = { recordId: "rec_alpha", amount };
  const before = { data: { id: "rec_alpha", amount: 120 } };
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
  const workspace = newTestHostWorkspace();
  hostToken = (await mintTestHostTokens(workspace)).hostToken;
  await resetTestHost(hostToken);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const companyIds = [sessionA?.companyId, sessionB?.companyId].filter(Boolean);
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
      isResume: false,
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
      isResume: true,
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
      await startCommit(sessionA, publicId);
      const finished = await repo.finishCommit({
        session: sessionA,
        changeRequestPublicId: publicId,
        hostCall: { outcome, mayHaveLanded, attempts: 1 },
        isResume: false,
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

describe("ActionEngineRepo cross-company isolation (diletta_app)", () => {
  it("never lets another company's session read, decide or commit a change request", async () => {
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
        isResume: false,
      });
      expect(finished.failure).toBe(Schemas.ChangeRequestFailureEnum.NotFound);
      const executionSet = await repo.setExecutionId({
        session,
        changeRequestPublicId: publicId,
        thinkExecutionId: "forged",
      });
      expect(executionSet.isSuccess).toBe(false);
      expect(executionSet.isNotFound).toBe(true);
    }

    const stillProposed = await repo.getChangeRequestViews({
      session: sessionA,
      changeRequestPublicIds: [publicId],
    });
    expect(stillProposed.changeRequests?.[0]?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Proposed,
    );
    expect((await getRow(publicId))?.thinkExecutionId).toBeNull();
  });

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
