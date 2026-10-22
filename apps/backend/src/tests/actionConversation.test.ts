import {
  env,
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getAgentByName } from "agents";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  changeRequests,
  chatbotConfigs,
  chatbotUsers,
  chatbots,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  conversations,
  eventOutbox,
  messages,
  modelCalls,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
import Constants from "@/config/Constants";
import worker from "@/index";
import ActionEngineRepo from "@/repositories/ActionEngineRepo";
import ChangeRequestPurgeRepo from "@/repositories/ChangeRequestPurgeRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import Utility from "@/utils/Utility";
import {
  anthropicReplyStream,
  anthropicToolCallsStream,
  gatewayRequests,
  mockCloudflare,
  mockedRequests,
} from "@/tests/helpers/gateway";
import {
  mintTestHostTokens,
  newTestHostWorkspace,
  render,
  resetTestHost,
  routeTestHostFetch,
  setTestHostFaults,
  testHostAdapter,
  testHostIssuer,
  testHostTool,
  testHostToolColumns,
} from "@/tests/helpers/testHost";
import { claimsFor, createKey, seedJwks, signToken } from "@/tests/helpers/widgetJwt";
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

// DEV_NOTE: The action engine end to end (M3-4): a signed companion JWT, GET /widget/ws, the Conversation DO, Think's
// durable-pause actions, ActionEngineRepo on Neon staging (as diletta_app), and the real test host (auxiliary worker,
// M3-3) behind the adapter. Each company is created through CompaniesRepo (so it has a company key) with a connection
// whose base_url is the test host's API, the test host's tool definitions (Active, version 1), a published config
// pinning them and a model key. The model is scripted (AI Gateway mocked); each test gets its own test host workspace.
// afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const ORIGIN = "https://app.example.com";
const END_TO_END_TIMEOUT_MS = 90_000;
// DEV_NOTE: One frame can wait on a whole turn: every step is a fresh connection plus round trips to the staging branch
// (an auto-commit turn takes ~30 s from a far region), so a frame gets most of the test's time, not a fixed 20 s
const FRAME_WAIT_MS = 60_000;
const createdCompanyIds: string[] = [];
let ownerPool: Pool | null = null;
let rsaKey: Awaited<ReturnType<typeof createKey>>;

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

type Tenant = Awaited<ReturnType<typeof createTenant>>;

async function createTenant(options: {
  tools: string[];
  isReadOnly?: boolean;
  approvalRules?: Schemas.ConfigSpecV1Input["approvalRules"];
}) {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Action test ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const issuer = `https://${crypto.randomUUID()}.example.com`;

  const tenant = await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .update(companies)
      .set({ isReadOnly: options.isReadOnly ?? false })
      .where(eq(companies.publicId, created.company?.publicId ?? ""))
      .returning({ id: companies.id });
    const companyId = company?.id ?? "";
    createdCompanyIds.push(companyId);

    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        name: "Records bot",
        isDefault: true,
      })
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
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
        jwtIssuer: issuer,
        allowedOrigins: [ORIGIN],
      })
      .returning({ id: companyConnections.id });
    for (const name of options.tools) {
      await ownerDb.insert(toolDefinitions).values({
        publicId: Utility.generatePublicId(),
        companyId,
        connectionId: connection?.id ?? "",
        version: 1,
        status: Schemas.ToolDefinitionStatusIntEnum.Active,
        ...testHostToolColumns(name),
      });
    }

    const normalized = Schemas.normalizeConfigBody({
      persona: { instructions: "You help the user keep their records up to date." },
      procedures: [],
      tools: options.tools.map((name) => ({ name, version: 1 })),
      approvalRules: options.approvalRules ?? [],
      routing: {
        small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
        mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
        top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
        defaultTier: Schemas.ModelTierEnum.Mid,
      },
      knowledge: { sourceIds: [] },
      widget: { greeting: "Hi", suggestions: [] },
    });
    if (!normalized.body || !normalized.schemaVersion) throw new Error(normalized.message);
    await ownerDb.insert(chatbotConfigs).values({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotId: chatbot?.id ?? "",
      configVersion: 1,
      schemaVersion: normalized.schemaVersion,
      status: Schemas.ChatbotConfigStatusIntEnum.Published,
      body: normalized.body,
      bodyHash: "test-1",
      publishedAt: new Date(),
    });
    return { companyId, chatbotId: chatbot?.id ?? "", issuer };
  });

  await seedJwks(issuer, [rsaKey.jwk]);
  await new CompanySecretsRepo(env).createCompanySecret({
    companyId: tenant.companyId,
    connectionId: null,
    companySecret: {
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider: Schemas.ModelProviderEnum.Anthropic,
      secret: `sk-ant-${crypto.randomUUID()}`,
      expiresAt: null,
    },
  });

  const workspace = newTestHostWorkspace();
  const { hostToken } = await mintTestHostTokens(workspace);
  await resetTestHost(hostToken);
  return { ...tenant, hostToken, workspace };
}

const parseFrame = (data: string) => JSON.parse(data) as Record<string, unknown> & { type: string };
type Frame = ReturnType<typeof parseFrame>;

async function connect(tenant: Tenant, options: { conversation?: string; roles?: string[] } = {}) {
  const token = await signToken(
    rsaKey,
    claimsFor(tenant.issuer, { sub: "host-user-1", roles: options.roles ?? [] }),
  );
  const query = options.conversation ? `?conversation=${options.conversation}` : "";
  const response = await worker.fetch(
    new Request(`http://localhost/widget/ws${query}`, {
      headers: {
        Upgrade: "websocket",
        Origin: ORIGIN,
        "Sec-WebSocket-Protocol": `${Schemas.WIDGET_SUBPROTOCOL}, ${token}`,
      },
    }),
    env,
    createExecutionContext(),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error(`Not connected: ${response.status}`);
  socket.accept();
  const frames: Frame[] = [];
  const waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  socket.addEventListener("message", (event) => {
    const frame = parseFrame(event.data as string);
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  // DEV_NOTE: The first frame (already received or still to come) after `from` that matches
  const waitFor = (match: (frame: Frame) => boolean, from = 0) =>
    new Promise<Frame>((resolve, reject) => {
      const seen = frames.slice(from).find(match);
      if (seen) return resolve(seen);
      const timer = setTimeout(
        () => reject(new Error(`Frame never arrived; got ${frames.map((f) => f.type).join(", ")}`)),
        FRAME_WAIT_MS,
      );
      waiters.push({
        match: (frame) => frames.indexOf(frame) >= from && match(frame),
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  const hello = (await waitFor(
    (frame) => frame.type === "conversation",
  )) as unknown as Schemas.WidgetConversationMessage;
  return { socket, frames, waitFor, publicId: hello.conversation.publicId };
}

type Socket = Awaited<ReturnType<typeof connect>>;

// DEV_NOTE: The model's answers, in order; any request past the script gets a plain reply
function scriptModel(script: ((model: string) => Response)[]) {
  let count = 0;
  mockCloudflare((mocked) => {
    const model = String(mocked.body?.model);
    const next = script[count];
    count += 1;
    return next ? next(model) : anthropicReplyStream(model, "Done.");
  });
}

function sendChat(socket: Socket, requestId: string, text: string) {
  socket.socket.send(
    JSON.stringify({
      type: Schemas.WidgetChatFrameTypeEnum.ChatRequest,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [{ id: `user-${requestId}`, role: "user", parts: [{ type: "text", text }] }],
        }),
      },
    }),
  );
  return socket.waitFor(
    (frame) =>
      frame.type === "cf_agent_use_chat_response" && frame.id === requestId && frame.done === true,
  );
}

const sendHostToken = (socket: Socket, token: string) =>
  socket.socket.send(JSON.stringify({ type: "host_token", token }));

const sendDecision = (socket: Socket, changeRequestId: string, decision: string) =>
  socket.socket.send(
    JSON.stringify({ type: "change_request_decision", changeRequestId, decision }),
  );

const changeRequestFrame =
  (status: Schemas.ChangeRequestStatusIntEnum) =>
  (frame: Frame): boolean =>
    frame.type === "change_request" &&
    (frame as unknown as Schemas.WidgetChangeRequestMessage).changeRequest.changeRequestStatus ===
      status;

const asChangeRequest = (frame: Frame) =>
  (frame as unknown as Schemas.WidgetChangeRequestMessage).changeRequest;

// DEV_NOTE: The continuation Think runs after an answer streams under its own request id
const isContinuationDone = (frame: Frame) =>
  frame.type === "cf_agent_use_chat_response" && frame.done === true && frame.continuation === true;

async function getChangeRequestRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.publicId, publicId));
    return row;
  });
}

async function getToolCallRows(companyId: string) {
  return await withOwnerDb((ownerDb) =>
    ownerDb
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.companyId, companyId))
      .orderBy(asc(toolCalls.id)),
  );
}

// DEV_NOTE: tool_calls rows of reads and refusals are written in waitUntil, just after the step
async function waitForToolCalls(companyId: string, count: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await getToolCallRows(companyId);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`tool_calls never reached ${count}`);
}

async function getRuntimeState(conversationPublicId: string) {
  const stub = await getAgentByName(env.CONVERSATION_DO, conversationPublicId);
  return await runInDurableObject(stub, (instance) =>
    Schemas.ZConversationRuntimeState.parse(instance.getConfig()),
  );
}

// DEV_NOTE: The execution id is read after the turn that parked it ends
async function waitForExecutionId(conversationPublicId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await getRuntimeState(conversationPublicId);
    const entry = Object.values(state.changeRequests)[0];
    if (entry?.executionId) return entry.executionId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Execution id never recorded");
}

async function readHostRecord(hostToken: string, recordId: string) {
  const adapter = testHostAdapter(() => hostToken);
  const response = await adapter.readback({
    request: render(testHostTool("get_record").ops.callOp, { args: { recordId } }),
  });
  return response.body as { data?: Record<string, unknown> } | undefined;
}

// DEV_NOTE: Think's private park step (0.19), reached only by the eviction test to build what a parked turn stores
const isParkFunction = (
  value: unknown,
): value is (args: Record<string, unknown>) => { executionId: string } =>
  typeof value === "function";

const updateAlpha =
  (amount: unknown, id = "toolu_update") =>
  (model: string) =>
    anthropicToolCallsStream(model, [
      { id, name: "update_record", input: { recordId: "rec_alpha", amount } },
    ]);
const reply = (text: string) => (model: string) => anthropicReplyStream(model, text);

beforeAll(async () => {
  rsaKey = await createKey(Schemas.WidgetJwtAlgorithmEnum.RS256, `rs-${crypto.randomUUID()}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockedRequests.length = 0;
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
      await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
      await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
      await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
      await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
      await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
      await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
      await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
      await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
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

describe("Action engine: proposal and durable pause", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  it("proposes a write from the read-before, parks it, and commits it once the user approves", async () => {
    const tenant = await createTenant({ tools: ["get_record", "update_record"] });
    scriptModel([
      updateAlpha(300),
      reply("The change is ready for your review."),
      reply("Done: the amount is now 300."),
    ]);
    routeTestHostFetch();
    const first = await connect(tenant);
    sendHostToken(first, tenant.hostToken);
    await sendChat(first, "req-1", "Set Alpha's amount to 300");

    // DEV_NOTE: The diff comes from the read-before (120) and the real args (300); the host is untouched
    const proposed = asChangeRequest(
      await first.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    expect(proposed).toMatchObject({
      toolName: "update_record",
      kind: Schemas.ChangeRequestKindEnum.Update,
      changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.Proposed,
      changeCount: 1,
      summary: "update_record: 1 field changed",
      isUndoable: true,
    });
    expect(proposed.changes).toEqual([
      {
        field: "amount",
        before: { isFound: true, value: 120 },
        after: { isFound: true, value: 300 },
        isChanged: true,
      },
      {
        field: "recordId",
        before: { isFound: true, value: "rec_alpha" },
        after: { isFound: true, value: "rec_alpha" },
        isChanged: false,
      },
    ]);
    expect(proposed.expiresAt).toBeGreaterThan(Date.now());
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);

    // DEV_NOTE: Stored encrypted, with Think's pause id once the turn has parked; the model was told to wait
    const executionId = await waitForExecutionId(first.publicId);
    const stored = await getChangeRequestRow(proposed.publicId);
    expect(stored?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Proposed);
    expect(stored?.thinkExecutionId).toBe(executionId);
    expect(Buffer.from(stored?.encryptedChanges ?? []).toString("utf8")).not.toContain("300");
    const [toolCall] = await getToolCallRows(tenant.companyId);
    expect(toolCall?.status).toBe(Schemas.ToolCallStatusIntEnum.Ok);
    expect(toolCall?.encryptedArgs).not.toBeNull();
    expect(JSON.stringify(gatewayRequests()[1]?.body?.messages)).toContain(
      "awaiting human approval",
    );

    // DEV_NOTE: A reconnecting widget gets the open proposal again, and its approval commits it as the user
    first.socket.close(1000);
    const second = await connect(tenant, { conversation: first.publicId });
    const resent = asChangeRequest(
      await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    expect(resent.publicId).toBe(proposed.publicId);
    expect(resent.changes).toEqual(proposed.changes);

    const from = second.frames.length;
    sendDecision(second, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    const committed = asChangeRequest(
      await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from),
    );
    expect(committed.publicId).toBe(proposed.publicId);
    await second.waitFor(isContinuationDone, from);

    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(300);
    const row = await getChangeRequestRow(proposed.publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Verified);
    expect(row?.idempotencyKey).toBe(Schemas.changeRequestCommitIdempotencyKey(proposed.publicId));
    const events = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ entityAction: activityLog.entityAction, actorType: activityLog.actorType })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, tenant.companyId),
            eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
          ),
        )
        .orderBy(asc(activityLog.id)),
    );
    expect(events.map((event) => event.entityAction)).toEqual([
      "proposed",
      "approved",
      "committing",
      "committed",
      "verified",
    ]);
    expect(events[1]?.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.ChatbotUser);

    // DEV_NOTE: The model's continuation saw the commit's outcome; the open change request is gone from the DO
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The change was made in the app and checked",
    );
    expect((await getRuntimeState(first.publicId)).changeRequests).toEqual({});
    second.socket.close(1000);
  });

  // DEV_NOTE: The Done-when. The test pool won't evict a DO that ran a turn (Think keeps it referenced), so this builds
  // exactly what a parked turn leaves in the DO's storage (the proposal stored through ActionEngineRepo, Think's own
  // pending-approval row, the transcript with the paused tool output, the runtime entry) in a DO that never ran one,
  // evicts it for real, and answers from a new socket after the wake: Think resolves the pause from its storage and
  // the commit lands. The host token was memory only, so the approval first asks for it.
  it("keeps a parked proposal across an eviction and commits it when approved after the wake", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([reply("Done: the amount is now 250.")]);
    routeTestHostFetch();
    const first = await connect(tenant);
    sendHostToken(first, tenant.hostToken);
    first.socket.close(1000);
    const stub = await getAgentByName(env.CONVERSATION_DO, first.publicId);
    const before = await readHostRecord(tenant.hostToken, "rec_alpha");
    const toolCallId = "toolu_parked";
    const args = { recordId: "rec_alpha", amount: 250 };

    // DEV_NOTE: The proposal is stored from the test (database work inside the DO would keep it referenced)
    const { session } = await getRuntimeState(first.publicId);
    const repo = new ActionEngineRepo(env);
    const loaded = await repo.loadTurnTools({
      session,
      pins: [{ name: "update_record", version: 1 }],
      isReadOnly: false,
    });
    const updateTool = loaded.tools?.[0];
    if (!updateTool?.ops.readbackOp) throw new Error("update_record not loaded");
    const turnId = Utility.generateUlid();
    const kind = Schemas.ChangeRequestKindEnum.Update;
    const proposed = await repo.proposeChange({
      session,
      turnId,
      tool: updateTool,
      args,
      kind,
      before,
      changes: Schemas.buildChangeRequestChanges({
        kind,
        callOp: updateTool.ops.callOp,
        readbackOp: updateTool.ops.readbackOp,
        args,
        before,
      }),
      isApprovalRequired: true,
      hasUntrustedContext: false,
      latencyMs: 1,
    });
    const proposedId = proposed.changeRequest?.publicId;
    if (!proposedId) throw new Error(proposed.message);

    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      const park: unknown = Reflect.get(instance, "_parkDurablePauseAction");
      if (!isParkFunction(park)) throw new Error("Think's park step not found");
      const paused = park.call(instance, {
        toolName: "update_record",
        input: args,
        ctx: { requestId: "", toolCallId },
        summary: "update_record",
        permissions: [],
        risk: undefined,
      });
      await instance.addMessages(
        [
          { id: "user-parked", role: "user", parts: [{ type: "text", text: "Set Alpha to 250" }] },
          {
            id: "reply-parked",
            role: "assistant",
            parts: [
              {
                type: "tool-update_record",
                toolCallId,
                state: "output-available",
                input: args,
                output: paused,
              },
            ],
          },
        ],
        { mode: "append", broadcast: false },
      );
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        turnIds: { "user-parked": turnId },
        changeRequests: {
          [toolCallId]: {
            publicId: proposedId,
            toolName: "update_record",
            turnId,
            stage: Schemas.ConversationChangeRequestStageEnum.Pending,
            expiresAt: Date.now() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS,
            executionId: paused.executionId,
            expiryScheduleId: null,
            tokenNeededSince: null,
            isUnsent: false,
          },
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evictDurableObject(stub, { webSockets: "close" });

    const second = await connect(tenant, { conversation: first.publicId });
    await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed));
    sendDecision(second, proposedId, Schemas.ChangeRequestDecisionEnum.Approve);
    await second.waitFor((frame) => frame.type === "token_needed");
    expect((await getChangeRequestRow(proposedId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Proposed,
    );

    sendHostToken(second, tenant.hostToken);
    const from = second.frames.length;
    sendDecision(second, proposedId, Schemas.ChangeRequestDecisionEnum.Approve);
    await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    await second.waitFor(isContinuationDone, from);

    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(250);
    expect((await getChangeRequestRow(proposedId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Verified,
    );
    const pending = await runInDurableObject(
      stub,
      async (instance) => await instance.pendingApprovals(),
    );
    expect(pending).toEqual([]);
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The change was made in the app and checked",
    );
    second.socket.close(1000);
  });

  it("rejects a proposal: nothing is written to the host and the model hears why", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([updateAlpha(5), reply("Waiting for you."), reply("OK, I won't change it.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "Set Alpha's amount to 5");
    const proposed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    await waitForExecutionId(socket.publicId);

    const from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Reject);
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Rejected), from);
    await socket.waitFor(isContinuationDone, from);

    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    expect((await getChangeRequestRow(proposed.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Rejected,
    );
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The user rejected the change",
    );

    // DEV_NOTE: A second answer finds nothing waiting
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    const refused = await socket.waitFor(
      (frame) =>
        frame.type === "error" &&
        frame.message === "This change is no longer waiting for your answer",
    );
    expect(refused).toBeDefined();
    socket.socket.close(1000);
  });

  it("expires a proposal left unanswered, and doesn't auto-close the conversation while it waits", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([updateAlpha(7), reply("Waiting for you."), reply("That change expired.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "Set Alpha's amount to 7");
    const proposed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    await waitForExecutionId(socket.publicId);
    const stub = await getAgentByName(env.CONVERSATION_DO, socket.publicId);

    // DEV_NOTE: Idle past the auto-close deadline, but a proposal is open: the close waits
    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        lastActivityAt: Date.now() - 31 * 60_000,
      });
      await instance.closeIfIdle();
    });
    expect((await getRuntimeState(socket.publicId)).isClosed).toBe(false);

    const from = socket.frames.length;
    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      const [toolCallId, entry] = Object.entries(state.changeRequests)[0]!;
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        changeRequests: { [toolCallId]: { ...entry, expiresAt: Date.now() - 1 } },
      });
      await instance.expireChangeRequest({ toolCallId });
    });
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Expired), from);
    await socket.waitFor(isContinuationDone, from);

    expect((await getChangeRequestRow(proposed.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Expired,
    );
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The change expired before the user approved it",
    );
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    socket.socket.close(1000);
  });
});

describe("Action engine: races and recovery", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  // DEV_NOTE: A turn that parks one update_record proposal (amount → `amount`), with Think's pause id recorded
  async function parkProposal(amount: number) {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([updateAlpha(amount), reply("Waiting for you."), reply("Done.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", `Set Alpha's amount to ${amount}`);
    const proposed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    await waitForExecutionId(socket.publicId);
    return { tenant, socket, proposed };
  }

  async function changeRequestEvents(companyId: string) {
    return await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ entityAction: activityLog.entityAction })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
          ),
        )
        .orderBy(asc(activityLog.id)),
    );
  }

  it("decides a double-clicked approval once: the second answer waits for the first", async () => {
    const { tenant, socket, proposed } = await parkProposal(310);
    const from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    await socket.waitFor(isContinuationDone, from);
    const refused = await socket.waitFor(
      (frame) =>
        frame.type === "error" &&
        (frame.message === "A reply is still in progress" ||
          frame.message === "This change is no longer waiting for your answer"),
      from,
    );
    expect(refused).toBeDefined();

    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(310);
    expect((await changeRequestEvents(tenant.companyId)).map((e) => e.entityAction)).toEqual([
      "proposed",
      "approved",
      "committing",
      "committed",
      "verified",
    ]);
    expect((await getRuntimeState(socket.publicId)).changeRequests).toEqual({});
    socket.socket.close(1000);
  });

  it("ends an approval that comes after the deadline as Expired, writing nothing", async () => {
    const { tenant, socket, proposed } = await parkProposal(320);
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(changeRequests)
        .set({
          createdAt: new Date(Date.now() - Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS - 1_000),
        })
        .where(eq(changeRequests.publicId, proposed.publicId)),
    );
    const from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Expired), from);
    await socket.waitFor(
      (frame) =>
        frame.type === "error" &&
        frame.message === "This change is no longer waiting for your answer",
      from,
    );
    await socket.waitFor(isContinuationDone, from);

    expect((await getChangeRequestRow(proposed.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Expired,
    );
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The change expired before the user approved it",
    );
    socket.socket.close(1000);
  });

  it("follows a change request the database already approved (a lost answer) and commits it", async () => {
    const { tenant, socket, proposed } = await parkProposal(330);
    const { session } = await getRuntimeState(socket.publicId);
    const approved = await new ActionEngineRepo(env).decideChangeRequest({
      session,
      changeRequestPublicId: proposed.publicId,
      decision: Schemas.ChangeRequestDecisionEnum.Approve,
      isExpired: false,
    });
    expect(approved.changeRequest?.changeRequestStatus).toBe(
      Schemas.ChangeRequestStatusIntEnum.Approved,
    );

    const from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    await socket.waitFor(isContinuationDone, from);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(330);
    expect((await getRuntimeState(socket.publicId)).changeRequests).toEqual({});
    socket.socket.close(1000);
  });

  // DEV_NOTE: An eviction mid-commit leaves the row Committing. On the wake the DO has no host token, so it sends
  // nothing (no NeedsHuman for a commit it couldn't even try); the widget's host_token frame resumes it, and the
  // Emulated tool reads back first (not landed) before it resends.
  it("resumes a commit an eviction cut short once the widget sends the host token again", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    routeTestHostFetch();
    const first = await connect(tenant);
    first.socket.close(1000);
    const stub = await getAgentByName(env.CONVERSATION_DO, first.publicId);
    const toolCallId = "toolu_cut";
    const args = { recordId: "rec_alpha", amount: 340 };

    const { session } = await getRuntimeState(first.publicId);
    const repo = new ActionEngineRepo(env);
    const loaded = await repo.loadTurnTools({
      session,
      pins: [{ name: "update_record", version: 1 }],
      isReadOnly: false,
    });
    const updateTool = loaded.tools?.[0];
    if (!updateTool?.ops.readbackOp) throw new Error("update_record not loaded");
    const before = await readHostRecord(tenant.hostToken, "rec_alpha");
    const kind = Schemas.ChangeRequestKindEnum.Update;
    const turnId = Utility.generateUlid();
    const proposed = await repo.proposeChange({
      session,
      turnId,
      tool: updateTool,
      args,
      kind,
      before,
      changes: Schemas.buildChangeRequestChanges({
        kind,
        callOp: updateTool.ops.callOp,
        readbackOp: updateTool.ops.readbackOp,
        args,
        before,
      }),
      isApprovalRequired: false,
      hasUntrustedContext: false,
      latencyMs: 1,
    });
    const publicId = proposed.changeRequest?.publicId;
    if (!publicId) throw new Error(proposed.message);
    const started = await repo.startCommit({
      session,
      changeRequestPublicId: publicId,
      attemptId: Utility.generateUlid(),
      isUnsent: false,
    });
    expect(started.plan?.isResume).toBe(false);

    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        changeRequests: {
          [toolCallId]: {
            publicId,
            toolName: "update_record",
            turnId,
            stage: Schemas.ConversationChangeRequestStageEnum.Committing,
            expiresAt: Date.now() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS,
            executionId: null,
            expiryScheduleId: null,
            tokenNeededSince: null,
            isUnsent: false,
          },
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evictDurableObject(stub, { webSockets: "close" });

    const second = await connect(tenant, { conversation: first.publicId });
    await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Committing));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await getChangeRequestRow(publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Committing,
    );

    const from = second.frames.length;
    sendHostToken(second, tenant.hostToken);
    await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(340);
    expect((await getChangeRequestRow(publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Verified,
    );
    expect((await getRuntimeState(first.publicId)).changeRequests).toEqual({});
    second.socket.close(1000);
  });
});

describe("Action engine: tool calls", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  it("reads host data for the model inside a fence, and the loop guard stops a repeated call", async () => {
    const tenant = await createTenant({ tools: ["get_record"] });
    const getBravo = (id: string) => (model: string) =>
      anthropicToolCallsStream(model, [
        { id, name: "get_record", input: { recordId: "rec_bravo" } },
      ]);
    scriptModel([getBravo("toolu_1"), getBravo("toolu_2"), reply("Bravo Labs owes 45.5.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "What does Bravo owe?");

    const [first, second] = gatewayRequests();
    expect(JSON.stringify(first?.body?.tools)).toContain("get_record");
    const toolResult = JSON.stringify(second?.body?.messages);
    expect(toolResult).toContain("<host_data>");
    expect(toolResult).toContain("Bravo Labs");
    // DEV_NOTE: The repeat is refused and ends the turn's loop: no third model call
    expect(gatewayRequests()).toHaveLength(2);

    // DEV_NOTE: Rows are written in waitUntil, so their order isn't the calls' order
    const rows = await waitForToolCalls(tenant.companyId, 2);
    expect(rows.map((row) => [row.status, row.errorCode])).toEqual(
      expect.arrayContaining([
        [Schemas.ToolCallStatusIntEnum.Ok, null],
        [Schemas.ToolCallStatusIntEnum.Blocked, Schemas.ToolCallErrorCodeEnum.LoopGuard],
      ]),
    );
    socket.socket.close(1000);
  });

  it("refuses args that don't fit the input schema and a write that changes nothing, proposing nothing", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([
      updateAlpha("lots", "toolu_bad"),
      updateAlpha(120, "toolu_same"),
      reply("Alpha already owes 120."),
    ]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "Make Alpha's amount 120");

    expect(JSON.stringify(gatewayRequests()[1]?.body?.messages)).toContain(
      "don't match the tool's input schema",
    );
    expect(JSON.stringify(gatewayRequests()[2]?.body?.messages)).toContain(
      "already holds these values",
    );
    const rows = await waitForToolCalls(tenant.companyId, 2);
    expect(rows.map((row) => [row.status, row.errorCode, row.encryptedArgs === null])).toEqual(
      expect.arrayContaining([
        [Schemas.ToolCallStatusIntEnum.Error, Schemas.ToolCallErrorCodeEnum.InvalidArgs, true],
        [Schemas.ToolCallStatusIntEnum.Ok, Schemas.ToolCallErrorCodeEnum.NoChange, false],
      ]),
    );
    const proposals = await withOwnerDb((ownerDb) =>
      ownerDb.select().from(changeRequests).where(eq(changeRequests.companyId, tenant.companyId)),
    );
    expect(proposals).toHaveLength(0);
    expect(socket.frames.some((frame) => frame.type === "change_request")).toBe(false);
    socket.socket.close(1000);
  });

  it("commits at once when an approval rule lets the user's role skip approval", async () => {
    const tenant = await createTenant({
      tools: ["update_record"],
      approvalRules: [
        {
          roles: ["manager"],
          tools: ["update_record"],
          approval: Schemas.ApprovalRuleApprovalEnum.Auto,
        },
      ],
    });
    // DEV_NOTE: The test host's update_record asks for approval Always; a Policy copy lets the rule apply
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(toolDefinitions)
        .set({ approval: Schemas.ToolDefinitionApprovalIntEnum.Policy })
        .where(eq(toolDefinitions.companyId, tenant.companyId)),
    );
    scriptModel([updateAlpha(64), reply("Done: 64.")]);
    routeTestHostFetch();
    const socket = await connect(tenant, { roles: ["manager"] });
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "Set Alpha's amount to 64");

    const committed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified)),
    );
    expect(committed.toolName).toBe("update_record");
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(64);
    expect(JSON.stringify(gatewayRequests()[1]?.body?.messages)).toContain(
      "The change was made in the app and checked",
    );
    socket.socket.close(1000);
  });

  it("offers a read-only company its read tools only", async () => {
    const tenant = await createTenant({ tools: ["get_record", "update_record"], isReadOnly: true });
    scriptModel([reply("I can only look things up.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    await sendChat(socket, "req-1", "Change Alpha");

    const tools = JSON.stringify(gatewayRequests()[0]?.body?.tools);
    expect(tools).toContain("get_record");
    expect(tools).not.toContain("update_record");
    socket.socket.close(1000);
  });
});

// DEV_NOTE: M3-5 — the widget's review: edits re-checked before anything commits (the Done-when), and bulk answers
// resolved together so the model replies once
describe("Action engine: edit and bulk review", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  const sendEdits = (
    socket: Socket,
    edits: { changeRequestId: string; values: Record<string, unknown> }[],
  ) => socket.socket.send(JSON.stringify({ type: "change_request_edits", edits }));

  const sendBatch = (
    socket: Socket,
    decisions: { changeRequestId: string; decision: Schemas.ChangeRequestDecisionEnum }[],
  ) => socket.socket.send(JSON.stringify({ type: "change_request_batch_decision", decisions }));

  const editAnswer =
    (changeRequestId: string) =>
    (frame: Frame): boolean =>
      frame.type === "change_request_edit" && frame.changeRequestId === changeRequestId;

  const asEditAnswer = (frame: Frame) => frame as unknown as Schemas.WidgetChangeRequestEditMessage;

  // DEV_NOTE: Each id is stored after its proposal's database step (setExecutionId), so it waits as long as a frame
  async function waitForExecutionIds(conversationPublicId: string, count: number) {
    const deadline = Date.now() + FRAME_WAIT_MS;
    while (Date.now() < deadline) {
      const entries = Object.values((await getRuntimeState(conversationPublicId)).changeRequests);
      if (entries.filter((entry) => entry.executionId).length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Execution ids never recorded");
  }

  async function parkProposal(amount: number) {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([updateAlpha(amount), reply("Waiting for you."), reply("Done.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", `Set Alpha's amount to ${amount}`);
    const proposed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    await waitForExecutionId(socket.publicId);
    return { tenant, socket, proposed };
  }

  async function writeHostAmount(hostToken: string, amount: number) {
    const tool = testHostTool("update_record");
    const response = await testHostAdapter(() => hostToken).execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Write,
      request: render(tool.ops.callOp, { args: { recordId: "rec_alpha", amount } }),
      idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.Native,
      idempotencyKey: `test-${crypto.randomUUID()}`,
      appliedCheck: null,
      isResume: false,
    });
    expect(response.outcome).toBe(Schemas.HostCallOutcomeEnum.Succeeded);
  }

  // DEV_NOTE: The Done-when. The edited value is checked against the input_schema, the record is read again (another
  // edit landed in the host meanwhile: the new diff shows it), the proposal waits with the re-checked diff, and only
  // the edited value is committed once the user approves.
  it("re-checks an edit (read-before again, diff rebuilt) and commits the edited value once approved", async () => {
    const { tenant, socket, proposed } = await parkProposal(300);
    expect(proposed.editableFields.map((field) => field.field)).toEqual([
      "name",
      "email",
      "amount",
      "status",
    ]);
    expect(proposed.toolCallId).toBe("toolu_update");
    expect(proposed.wasEdited).toBe(false);
    await writeHostAmount(tenant.hostToken, 200);

    let from = socket.frames.length;
    sendEdits(socket, [{ changeRequestId: proposed.publicId, values: { amount: 450 } }]);
    const answer = asEditAnswer(await socket.waitFor(editAnswer(proposed.publicId), from));
    expect(answer).toMatchObject({ isSaved: true, message: null });
    const edited = asChangeRequest(
      await socket.waitFor(
        (frame) =>
          changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)(frame) &&
          asChangeRequest(frame).wasEdited,
        from,
      ),
    );
    expect(edited.changes?.[0]).toEqual({
      field: "amount",
      before: { isFound: true, value: 200 },
      after: { isFound: true, value: 450 },
      isChanged: true,
    });
    expect(edited.expiresAt).toBe(proposed.expiresAt);
    const row = await getChangeRequestRow(proposed.publicId);
    expect(row?.wasEdited).toBe(true);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Proposed);
    expect(Buffer.from(row?.encryptedChanges ?? []).toString("utf8")).not.toContain("450");
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(200);

    from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    await socket.waitFor(isContinuationDone, from);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(450);
    const events = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ entityAction: activityLog.entityAction, actorType: activityLog.actorType })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, tenant.companyId),
            eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
          ),
        )
        .orderBy(asc(activityLog.id)),
    );
    expect(events.map((event) => event.entityAction)).toEqual([
      "proposed",
      "edited",
      "approved",
      "committing",
      "committed",
      "verified",
    ]);
    expect(events[1]?.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.ChatbotUser);
    socket.socket.close(1000);
  });

  it("refuses an edit of the record's id, a value the input_schema rejects, and one that changes nothing", async () => {
    const { tenant, socket, proposed } = await parkProposal(300);
    const attempts: Record<string, unknown>[] = [
      { recordId: "rec_bravo" },
      { amount: "lots" },
      { amount: Schemas.TEST_HOST_AMOUNT_LIMIT + 1 },
      { amount: 120 },
    ];
    for (const values of attempts) {
      const from = socket.frames.length;
      sendEdits(socket, [{ changeRequestId: proposed.publicId, values }]);
      const answer = asEditAnswer(await socket.waitFor(editAnswer(proposed.publicId), from));
      expect(answer.isSaved).toBe(false);
      expect(answer.message).toContain("Nothing changed");
    }
    const row = await getChangeRequestRow(proposed.publicId);
    expect(row?.wasEdited).toBe(false);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Proposed);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    socket.socket.close(1000);
  });

  it("refuses an edit after the deadline, and asks for the host token before an edit's read", async () => {
    const { tenant, socket, proposed } = await parkProposal(300);
    // DEV_NOTE: The DO's memory without the host token (an eviction drops it): the edit asks for it, changing nothing
    await runInDurableObject(
      await getAgentByName(env.CONVERSATION_DO, socket.publicId),
      (instance) => {
        Reflect.set(instance, "hostToken", null);
      },
    );
    let from = socket.frames.length;
    sendEdits(socket, [{ changeRequestId: proposed.publicId, values: { amount: 400 } }]);
    await socket.waitFor((frame) => frame.type === "token_needed", from);

    sendHostToken(socket, tenant.hostToken);
    await withOwnerDb((ownerDb) =>
      ownerDb
        .update(changeRequests)
        .set({
          createdAt: new Date(Date.now() - Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS - 1_000),
        })
        .where(eq(changeRequests.publicId, proposed.publicId)),
    );
    from = socket.frames.length;
    sendEdits(socket, [{ changeRequestId: proposed.publicId, values: { amount: 400 } }]);
    const answer = asEditAnswer(await socket.waitFor(editAnswer(proposed.publicId), from));
    expect(answer).toMatchObject({
      isSaved: false,
      message: "This change is no longer waiting for your answer",
    });
    expect((await getChangeRequestRow(proposed.publicId))?.wasEdited).toBe(false);
    socket.socket.close(1000);
  });

  // DEV_NOTE: Two writes of one step park together; one batch answers both (approve one, reject the other): the
  // approved one is committed, the rejected one never reaches the host, and Think continues the chat once
  it("decides a bulk review in one batch: commits the approved, rejects the rest, and the model replies once", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([
      (model) =>
        anthropicToolCallsStream(model, [
          {
            id: "toolu_alpha",
            name: "update_record",
            input: { recordId: "rec_alpha", amount: 70 },
          },
          {
            id: "toolu_bravo",
            name: "update_record",
            input: { recordId: "rec_bravo", amount: 80 },
          },
        ]),
      reply("Both are ready for your review."),
      reply("Alpha is updated; Bravo stays as it was."),
    ]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "Set Alpha to 70 and Bravo to 80");
    await waitForExecutionIds(socket.publicId, 2);
    const entries = Object.entries((await getRuntimeState(socket.publicId)).changeRequests);
    const alpha = entries.find(([toolCallId]) => toolCallId === "toolu_alpha")?.[1];
    const bravo = entries.find(([toolCallId]) => toolCallId === "toolu_bravo")?.[1];
    if (!alpha || !bravo) throw new Error("Both proposals not parked");
    const requestsBefore = gatewayRequests().length;

    const from = socket.frames.length;
    sendBatch(socket, [
      { changeRequestId: alpha.publicId, decision: Schemas.ChangeRequestDecisionEnum.Approve },
      { changeRequestId: bravo.publicId, decision: Schemas.ChangeRequestDecisionEnum.Reject },
    ]);
    await socket.waitFor(isContinuationDone, from);

    expect((await getChangeRequestRow(alpha.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Verified,
    );
    expect((await getChangeRequestRow(bravo.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Rejected,
    );
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(70);
    expect((await readHostRecord(tenant.hostToken, "rec_bravo"))?.data?.amount).toBe(45.5);
    // DEV_NOTE: One continuation for the whole batch, which saw both outcomes
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(gatewayRequests().length).toBe(requestsBefore + 1);
    const continuation = JSON.stringify(gatewayRequests().at(-1)?.body?.messages);
    expect(continuation).toContain("The change was made in the app and checked");
    expect(continuation).toContain("The user rejected the change.");
    expect((await getRuntimeState(socket.publicId)).changeRequests).toEqual({});
    socket.socket.close(1000);
  });

  it("asks for the host token before a batch with an approval decides anything", async () => {
    const { tenant, socket, proposed } = await parkProposal(300);
    await runInDurableObject(
      await getAgentByName(env.CONVERSATION_DO, socket.publicId),
      (instance) => {
        Reflect.set(instance, "hostToken", null);
      },
    );
    const from = socket.frames.length;
    sendBatch(socket, [
      { changeRequestId: proposed.publicId, decision: Schemas.ChangeRequestDecisionEnum.Approve },
    ]);
    await socket.waitFor((frame) => frame.type === "token_needed", from);
    expect((await getChangeRequestRow(proposed.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Proposed,
    );
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    socket.socket.close(1000);
  });
});

// DEV_NOTE: The Done-when (M3-6): every outcome of a landed commit, end to end through the widget socket, the DO and
// the test host. Faults are queued after the proposal, so the read-before never takes one.
describe(
  "Action engine: read-after, auto-undo and needs a person (M3-6)",
  { timeout: END_TO_END_TIMEOUT_MS },
  () => {
    async function approveAlpha(
      amount: number,
      faults: Schemas.TestHostFault[],
      options: { isUndoable?: boolean } = {},
    ) {
      const tenant = await createTenant({ tools: ["update_record"] });
      if (options.isUndoable === false) {
        await withOwnerDb((ownerDb) =>
          ownerDb
            .update(toolDefinitions)
            .set({ inverseOp: null })
            .where(eq(toolDefinitions.companyId, tenant.companyId)),
        );
      }
      scriptModel([updateAlpha(amount), reply("Waiting for you."), reply("Done.")]);
      routeTestHostFetch();
      const socket = await connect(tenant);
      sendHostToken(socket, tenant.hostToken);
      await sendChat(socket, "req-1", `Set Alpha's amount to ${amount}`);
      const proposed = asChangeRequest(
        await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
      );
      await waitForExecutionId(socket.publicId);
      await setTestHostFaults(tenant.workspace, faults);
      const from = socket.frames.length;
      sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
      return { tenant, socket, proposed, from };
    }

    async function eventsOf(companyId: string) {
      const rows = await withOwnerDb((ownerDb) =>
        ownerDb
          .select({ entityAction: activityLog.entityAction })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
            ),
          )
          .orderBy(asc(activityLog.id)),
      );
      return rows.map((row) => row.entityAction);
    }

    const overwriteAmount: Schemas.TestHostFault = {
      kind: Schemas.TestHostFaultKindEnum.Overwrite,
      method: Schemas.ToolOpMethodEnum.Patch,
      fields: { amount: 999 },
    };

    it("verifies a create and a delete: the new record read back by the host's id, the deleted one gone", async () => {
      const tenant = await createTenant({ tools: ["create_record", "delete_record"] });
      scriptModel([
        (model) =>
          anthropicToolCallsStream(model, [
            {
              id: "toolu_create",
              name: "create_record",
              input: { name: "Delta Works", email: "ops@delta.example", amount: 75 },
            },
          ]),
        reply("Ready for your review."),
        reply("Added."),
        (model) =>
          anthropicToolCallsStream(model, [
            { id: "toolu_delete", name: "delete_record", input: { recordId: "rec_bravo" } },
          ]),
        reply("Ready for your review."),
        reply("Deleted."),
      ]);
      routeTestHostFetch();
      const socket = await connect(tenant);
      sendHostToken(socket, tenant.hostToken);

      await sendChat(socket, "req-1", "Add Delta Works");
      const created = asChangeRequest(
        await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
      );
      expect(created.kind).toBe(Schemas.ChangeRequestKindEnum.Create);
      await waitForExecutionId(socket.publicId);
      let from = socket.frames.length;
      sendDecision(socket, created.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
      await socket.waitFor(isContinuationDone, from);
      const createdRow = await getChangeRequestRow(created.publicId);
      expect(createdRow?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Verified);
      expect(createdRow?.hostRef).toMatch(/^rec_/);
      expect(
        (await readHostRecord(tenant.hostToken, createdRow?.hostRef ?? ""))?.data?.amount,
      ).toBe(75);

      await sendChat(socket, "req-2", "Delete Bravo");
      const deleted = asChangeRequest(
        await socket.waitFor(
          (frame) =>
            changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)(frame) &&
            asChangeRequest(frame).publicId !== created.publicId,
        ),
      );
      expect(deleted.kind).toBe(Schemas.ChangeRequestKindEnum.Delete);
      await waitForExecutionId(socket.publicId);
      from = socket.frames.length;
      sendDecision(socket, deleted.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
      await socket.waitFor(isContinuationDone, from);
      expect((await getChangeRequestRow(deleted.publicId))?.status).toBe(
        Schemas.ChangeRequestStatusIntEnum.Verified,
      );
      expect(await readHostRecord(tenant.hostToken, "rec_bravo")).toBeUndefined();
      expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
        "The change was made in the app and checked",
      );
      socket.socket.close(1000);
    });

    it("undoes a commit the read-after finds otherwise, and tells the widget what it found", async () => {
      const { tenant, socket, proposed, from } = await approveAlpha(300, [overwriteAmount]);
      const undone = asChangeRequest(
        await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Undone), from),
      );
      await socket.waitFor(isContinuationDone, from);

      expect(undone.publicId).toBe(proposed.publicId);
      expect(undone.mismatches).toEqual([
        {
          field: "amount",
          expected: { isFound: true, value: 300 },
          found: { isFound: true, value: 999 },
        },
      ]);
      // DEV_NOTE: Put back to its read-before values (the concurrent 999 included: all-or-nothing per change request)
      expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
      const row = await getChangeRequestRow(proposed.publicId);
      expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Undone);
      expect(row?.errorCode).toBeNull();
      expect(row?.idempotencyKey).toBe(Schemas.changeRequestUndoIdempotencyKey(proposed.publicId));
      expect(Buffer.from(row?.encryptedChanges ?? []).toString("utf8")).not.toContain("999");
      expect(await eventsOf(tenant.companyId)).toEqual([
        "proposed",
        "approved",
        "committing",
        "committed",
        "mismatch",
        "undoing",
        "undone",
      ]);
      expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
        "so it was undone",
      );
      expect((await getRuntimeState(socket.publicId)).changeRequests).toEqual({});
      socket.socket.close(1000);
    });

    it("hands a mismatch to a person when its undo fails", async () => {
      // DEV_NOTE: The undo answers 500: it may have landed, and its Emulated check shows neither side (999), so it is
      // never resent
      const failed = await approveAlpha(300, [
        overwriteAmount,
        {
          kind: Schemas.TestHostFaultKindEnum.Status,
          method: Schemas.ToolOpMethodEnum.Patch,
          status: 500,
          isApplied: false,
        },
      ]);
      await failed.socket.waitFor(
        changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.NeedsHuman),
        failed.from,
      );
      await failed.socket.waitFor(isContinuationDone, failed.from);
      expect((await getChangeRequestRow(failed.proposed.publicId))?.errorCode).toBe(
        Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
      );
      expect((await readHostRecord(failed.tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(999);
      expect(await eventsOf(failed.tenant.companyId)).toEqual([
        "proposed",
        "approved",
        "committing",
        "committed",
        "mismatch",
        "undoing",
        "needs_human",
      ]);
      expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
        "sent to the team for review",
      );
      failed.socket.socket.close(1000);
    });

    it("hands a mismatch to a person when the tool can't be undone", async () => {
      const notUndoable = await approveAlpha(300, [overwriteAmount], { isUndoable: false });
      const flagged = asChangeRequest(
        await notUndoable.socket.waitFor(
          changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.NeedsHuman),
          notUndoable.from,
        ),
      );
      // DEV_NOTE: Its continuation must end here, or its model call takes the next test's script
      await notUndoable.socket.waitFor(isContinuationDone, notUndoable.from);
      expect(flagged.isUndoable).toBe(false);
      expect(flagged.mismatches).toHaveLength(1);
      expect((await getChangeRequestRow(notUndoable.proposed.publicId))?.errorCode).toBe(
        Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
      );
      expect(await eventsOf(notUndoable.tenant.companyId)).toEqual([
        "proposed",
        "approved",
        "committing",
        "committed",
        "mismatch",
        "needs_human",
      ]);
      notUndoable.socket.socket.close(1000);
    });

    it("hands a commit whose read-after can't be read to a person, and undoes nothing", async () => {
      const unavailable: Schemas.TestHostFault = {
        kind: Schemas.TestHostFaultKindEnum.Status,
        method: Schemas.ToolOpMethodEnum.Get,
        status: 503,
        isApplied: false,
      };
      // DEV_NOTE: One per attempt: the read and its retries (HOST_CALL_MAX_RETRIES)
      const faults = Array.from({ length: Schemas.HOST_CALL_MAX_RETRIES + 1 }, () => unavailable);
      const { tenant, socket, proposed, from } = await approveAlpha(300, faults);
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.NeedsHuman), from);
      await socket.waitFor(isContinuationDone, from);

      expect((await getChangeRequestRow(proposed.publicId))?.errorCode).toBe(
        Schemas.ChangeRequestErrorCodeEnum.VerifyUnknown,
      );
      expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(300);
      expect(await eventsOf(tenant.companyId)).toEqual([
        "proposed",
        "approved",
        "committing",
        "committed",
        "needs_human",
      ]);
      socket.socket.close(1000);
    });
  },
);

describe("Action engine: undo window and purge (M3-7)", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  const sendUndos = (socket: Socket, changeRequestIds: string[]) =>
    socket.socket.send(JSON.stringify({ type: "change_request_undos", changeRequestIds }));
  const undoAnswer =
    (changeRequestId: string) =>
    (frame: Frame): boolean =>
      frame.type === "change_request_undo" &&
      (frame as unknown as Schemas.WidgetChangeRequestUndoMessage).changeRequestId ===
        changeRequestId;
  const asUndoAnswer = (frame: Frame) => frame as unknown as Schemas.WidgetChangeRequestUndoMessage;
  const setUndoUntil = (publicId: string, undoUntil: Date) =>
    withOwnerDb((ownerDb) =>
      ownerDb
        .update(changeRequests)
        .set({ undoUntil })
        .where(eq(changeRequests.publicId, publicId)),
    );

  // DEV_NOTE: rec_alpha's amount changed, approved, committed and read back as set: Verified, inside its undo window
  async function verifyAlpha(amount: number, after: ((model: string) => Response)[] = []) {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([updateAlpha(amount), reply("Waiting for you."), reply("Done."), ...after]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", `Set Alpha's amount to ${amount}`);
    const proposed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    await waitForExecutionId(socket.publicId);
    const from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    const verified = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from),
    );
    await socket.waitFor(isContinuationDone, from);
    return { tenant, socket, verified };
  }

  it("undoes a verified change from the card's Undo: the record back, Undone, and the next turn hears it", async () => {
    const { tenant, socket, verified } = await verifyAlpha(310, [reply("Noted.")]);
    expect(verified.undoUntil).toBeGreaterThan(Date.now());
    expect(verified.toolCallId).toBe("toolu_update");
    expect(Object.values((await getRuntimeState(socket.publicId)).undoWindows)).toEqual([
      { publicId: verified.publicId, undoUntil: verified.undoUntil },
    ]);

    const from = socket.frames.length;
    sendUndos(socket, [verified.publicId]);
    expect(asUndoAnswer(await socket.waitFor(undoAnswer(verified.publicId), from))).toMatchObject({
      isStarted: true,
      message: null,
    });
    const undone = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Undone), from),
    );
    expect(undone).toMatchObject({ mismatches: null, undoUntil: null, isUndoing: false });
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    const row = await getChangeRequestRow(verified.publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Undone);
    const state = await getRuntimeState(socket.publicId);
    expect(state.undoWindows).toEqual({});
    expect(state.changeRequests).toEqual({});
    expect(state.userUndos).toEqual({ [verified.publicId]: row?.summary });

    // DEV_NOTE: No model call for the undo; the next message's system prompt says what the user undid, once
    const callsBefore = gatewayRequests().length;
    await sendChat(socket, "req-2", "Thanks");
    expect(gatewayRequests().length).toBe(callsBefore + 1);
    expect(JSON.stringify(gatewayRequests().at(-1)?.body)).toContain(
      "the user undid these changes",
    );
    // DEV_NOTE: Kept for every later turn: the transcript still says the change was made
    expect((await getRuntimeState(socket.publicId)).userUndos).toEqual(state.userUndos);
    socket.socket.close(1000);
  });

  it("keeps Undo across a reconnect, asks for the host token, and refuses an undo after the window", async () => {
    const { tenant, socket, verified } = await verifyAlpha(320);
    socket.socket.close(1000);
    // DEV_NOTE: An eviction drops the host token (memory only). Think holds the DO after a model turn, so the test
    // drops the token itself rather than evicting; the reconnect re-sends the card with its Undo either way.
    const stub = await getAgentByName(env.CONVERSATION_DO, socket.publicId);
    await runInDurableObject(stub, (instance) => {
      Reflect.set(instance, "hostToken", null);
    });
    const second = await connect(tenant, { conversation: socket.publicId });
    const resent = asChangeRequest(
      await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified)),
    );
    expect(resent).toMatchObject({
      publicId: verified.publicId,
      toolCallId: "toolu_update",
      undoUntil: verified.undoUntil,
    });
    let from = second.frames.length;
    sendUndos(second, [verified.publicId]);
    await second.waitFor((frame) => frame.type === "token_needed", from);
    expect((await getChangeRequestRow(verified.publicId))?.idempotencyKey).toBe(
      Schemas.changeRequestCommitIdempotencyKey(verified.publicId),
    );

    await setUndoUntil(verified.publicId, new Date(Date.now() - 1_000));
    sendHostToken(second, tenant.hostToken);
    from = second.frames.length;
    sendUndos(second, [verified.publicId]);
    expect(asUndoAnswer(await second.waitFor(undoAnswer(verified.publicId), from))).toEqual({
      type: "change_request_undo",
      changeRequestId: verified.publicId,
      isStarted: false,
      message: "The time to undo this change has passed. Nothing changed.",
    });
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(320);
    expect((await getChangeRequestRow(verified.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Verified,
    );
    expect((await getRuntimeState(socket.publicId)).undoWindows).toEqual({});
    second.socket.close(1000);
  });

  it("doesn't auto-close while a change can be undone, and closes once the window ends", async () => {
    const { socket, verified } = await verifyAlpha(330);
    socket.socket.close(1000);
    const stub = await getAgentByName(env.CONVERSATION_DO, socket.publicId);
    const idleSince = Date.now() - Constants.CONVERSATION_IDLE_CLOSE_MS - 1_000;
    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      instance.configure<Schemas.ConversationRuntimeState>({ ...state, lastActivityAt: idleSince });
      await instance.closeIfIdle();
    });
    expect((await getRuntimeState(socket.publicId)).isClosed).toBe(false);

    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        lastActivityAt: idleSince,
        undoWindows: Object.fromEntries(
          Object.entries(state.undoWindows).map(([toolCallId, window]) => [
            toolCallId,
            { ...window, undoUntil: Date.now() - 1 },
          ]),
        ),
      });
      await instance.closeIfIdle();
    });
    const closed = await getRuntimeState(socket.publicId);
    expect(closed.isClosed).toBe(true);
    expect(closed.undoWindows).toEqual({});
    expect((await getChangeRequestRow(verified.publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Verified,
    );
  });

  // DEV_NOTE: A user undo cut short after startUndo (an eviction): the row holds the user's undo key and the DO an open
  // user_undoing entry, as runUserUndo leaves them
  async function cutShortUndo(
    conversationPublicId: string,
    verified: Schemas.WidgetChangeRequest,
    expiresAt: number,
  ) {
    const stub = await getAgentByName(env.CONVERSATION_DO, conversationPublicId);
    const { session } = await getRuntimeState(conversationPublicId);
    const started = await new ActionEngineRepo(env).startUndo({
      session,
      changeRequestPublicId: verified.publicId,
      attemptId: Utility.generateUlid(),
    });
    expect(started.followUp?.isResume).toBe(false);
    await runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "hostToken", null);
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        changeRequests: {
          [verified.toolCallId ?? ""]: {
            publicId: verified.publicId,
            toolName: "update_record",
            turnId: null,
            stage: Schemas.ConversationChangeRequestStageEnum.UserUndoing,
            expiresAt,
            executionId: null,
            expiryScheduleId: null,
            tokenNeededSince: null,
            isUnsent: false,
          },
        },
      });
    });
    return stub;
  }

  it("resumes a user undo cut short once the host token is back, and every later turn hears it", async () => {
    const { tenant, socket, verified } = await verifyAlpha(350);
    socket.socket.close(1000);
    await cutShortUndo(socket.publicId, verified, Date.now() + 3_600_000);

    const second = await connect(tenant, { conversation: socket.publicId });
    const from = second.frames.length;
    sendHostToken(second, tenant.hostToken);
    const undone = asChangeRequest(
      await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Undone), from),
    );
    expect(undone.undoneBy).toBe(Schemas.ChangeRequestUndoneByEnum.User);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
    const state = await getRuntimeState(socket.publicId);
    expect(state.changeRequests).toEqual({});
    expect(Object.keys(state.userUndos)).toEqual([verified.publicId]);
    second.socket.close(1000);
  });

  it("hands a user undo nobody came back to finish to a person, then lets the conversation close", async () => {
    const { socket, verified } = await verifyAlpha(360);
    socket.socket.close(1000);
    const stub = await cutShortUndo(socket.publicId, verified, Date.now() - 1);
    const idleSince = Date.now() - Constants.CONVERSATION_IDLE_CLOSE_MS - 1_000;
    const closeWhenIdle = () =>
      runInDurableObject(stub, async (instance) => {
        const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
        instance.configure<Schemas.ConversationRuntimeState>({
          ...state,
          lastActivityAt: idleSince,
          undoWindows: {},
        });
        await instance.closeIfIdle();
      });

    await closeWhenIdle();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (Object.keys((await getRuntimeState(socket.publicId)).changeRequests).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const row = await getChangeRequestRow(verified.publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.NeedsHuman);
    expect(row?.errorCode).toBe(Schemas.ChangeRequestErrorCodeEnum.UndoInterrupted);
    expect(row?.encryptedChanges).not.toBeNull();

    await closeWhenIdle();
    expect((await getRuntimeState(socket.publicId)).isClosed).toBe(true);
  });

  it("empties encrypted_changes once the window ends, and the card no longer offers Undo", async () => {
    const { tenant, socket, verified } = await verifyAlpha(340);
    socket.socket.close(1000);
    expect((await getChangeRequestRow(verified.publicId))?.encryptedChanges).not.toBeNull();

    await setUndoUntil(verified.publicId, new Date(Date.now() - 1_000));
    const purged = await new ChangeRequestPurgeRepo(env).purgeExpiredValues();
    expect(purged.isSuccess).toBe(true);
    const row = await getChangeRequestRow(verified.publicId);
    expect(row).toMatchObject({ encryptedChanges: null, iv: null, encryptionKeyVersion: null });
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Verified);
    expect(row?.summary).toBe(verified.summary);

    const second = await connect(tenant, { conversation: socket.publicId });
    const resent = asChangeRequest(
      await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified)),
    );
    expect(resent).toMatchObject({ changes: null, undoUntil: null });
    const from = second.frames.length;
    sendUndos(second, [verified.publicId]);
    expect(asUndoAnswer(await second.waitFor(undoAnswer(verified.publicId), from)).isStarted).toBe(
      false,
    );
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(340);
    second.socket.close(1000);
  });
});

// DEV_NOTE: Token refresh (M3-8): the DO asks the widget for a fresh host token (token_needed, reason refresh) when a
// step finds none or the host refuses it, and the widget answers with no UI. A change request whose token never comes
// back (the widget closed) goes to a person after HOST_TOKEN_GRACE_MS.
describe("Action engine: token refresh (M3-8)", { timeout: END_TO_END_TIMEOUT_MS }, () => {
  const isRefresh = (frame: Frame) =>
    frame.type === "token_needed" && frame.reason === Schemas.WidgetTokenNeededReasonEnum.Refresh;

  it("asks for the host token when a read finds none, and the read goes on with no UI (the Done-when)", async () => {
    const tenant = await createTenant({ tools: ["get_record"] });
    scriptModel([
      (model) =>
        anthropicToolCallsStream(model, [
          { id: "toolu_read", name: "get_record", input: { recordId: "rec_bravo" } },
        ]),
      reply("Bravo Labs owes 45.5."),
    ]);
    routeTestHostFetch();
    // DEV_NOTE: No host_token after connect: the DO's memory holds none, as after an eviction
    const socket = await connect(tenant);
    const done = sendChat(socket, "req-1", "What does Bravo owe?");
    await socket.waitFor(isRefresh);
    sendHostToken(socket, tenant.hostToken);
    await done;

    const toolResult = JSON.stringify(gatewayRequests()[1]?.body?.messages);
    expect(toolResult).toContain("Bravo Labs");
    expect(toolResult).not.toContain("signed in again");
    const rows = await waitForToolCalls(tenant.companyId, 1);
    expect(rows.map((row) => [row.status, row.errorCode])).toEqual([
      [Schemas.ToolCallStatusIntEnum.Ok, null],
    ]);
    // DEV_NOTE: Nothing for the widget to show: no error or notice frame
    expect(socket.frames.some((frame) => frame.type === "error")).toBe(false);
    socket.socket.close(1000);
  });

  it("asks for a fresh token when the host refuses the commit's, and commits once with it", async () => {
    const tenant = await createTenant({ tools: ["update_record"] });
    scriptModel([updateAlpha(360), reply("Waiting for you."), reply("Done.")]);
    routeTestHostFetch();
    const socket = await connect(tenant);
    sendHostToken(socket, tenant.hostToken);
    await sendChat(socket, "req-1", "Set Alpha's amount to 360");
    const proposed = asChangeRequest(
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Proposed)),
    );
    await waitForExecutionId(socket.publicId);
    // DEV_NOTE: The host refuses the commit's token before anything runs (an expired token)
    await setTestHostFaults(tenant.workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        method: Schemas.ToolOpMethodEnum.Patch,
        status: 401,
        isApplied: false,
      },
    ]);
    const from = socket.frames.length;
    sendDecision(socket, proposed.publicId, Schemas.ChangeRequestDecisionEnum.Approve);
    await socket.waitFor(isRefresh, from);
    const { hostToken: freshToken } = await mintTestHostTokens(tenant.workspace);
    sendHostToken(socket, freshToken);

    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(360);
    const row = await getChangeRequestRow(proposed.publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Verified);
    expect(row?.errorCode).toBeNull();
    socket.socket.close(1000);
  });

  // DEV_NOTE: A change request the DO holds with no turn running (as after a wake): proposed with no approval needed
  // (Approved), Committing when its commit already started once. The first socket is closed; the caller connects
  // again if it needs one.
  async function seedEntry(options: {
    toolName: "update_record" | "create_record";
    args: Record<string, unknown>;
    stage:
      | Schemas.ConversationChangeRequestStageEnum.Approved
      | Schemas.ConversationChangeRequestStageEnum.Committing;
  }) {
    const tenant = await createTenant({ tools: [options.toolName] });
    routeTestHostFetch();
    const first = await connect(tenant);
    first.socket.close(1000);
    const stub = await getAgentByName(env.CONVERSATION_DO, first.publicId);
    const toolCallId = `toolu_${crypto.randomUUID().slice(0, 8)}`;

    const { session } = await getRuntimeState(first.publicId);
    const repo = new ActionEngineRepo(env);
    const loaded = await repo.loadTurnTools({
      session,
      pins: [{ name: options.toolName, version: 1 }],
      isReadOnly: false,
    });
    const hostTool = loaded.tools?.[0];
    if (!hostTool?.ops.readbackOp || hostTool.risk === Schemas.ToolDefinitionRiskIntEnum.Read) {
      throw new Error(`${options.toolName} not loaded as a write tool`);
    }
    const kind = Schemas.getChangeRequestKind(hostTool.risk, hostTool.ops.readbackOp);
    const before = Schemas.hasReadBefore(kind)
      ? await readHostRecord(tenant.hostToken, String(options.args.recordId))
      : null;
    const turnId = Utility.generateUlid();
    const proposed = await repo.proposeChange({
      session,
      turnId,
      tool: hostTool,
      args: options.args,
      kind,
      before,
      changes: Schemas.buildChangeRequestChanges({
        kind,
        callOp: hostTool.ops.callOp,
        readbackOp: hostTool.ops.readbackOp,
        args: options.args,
        before,
      }),
      isApprovalRequired: false,
      hasUntrustedContext: false,
      latencyMs: 1,
    });
    const publicId = proposed.changeRequest?.publicId;
    if (!publicId) throw new Error(proposed.message);
    if (options.stage === Schemas.ConversationChangeRequestStageEnum.Committing) {
      const started = await repo.startCommit({
        session,
        changeRequestPublicId: publicId,
        attemptId: Utility.generateUlid(),
        isUnsent: false,
      });
      if (!started.plan) throw new Error(started.message);
    }

    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        changeRequests: {
          [toolCallId]: {
            publicId,
            toolName: options.toolName,
            turnId,
            stage: options.stage,
            expiresAt: Date.now() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS,
            executionId: null,
            expiryScheduleId: null,
            tokenNeededSince: null,
            isUnsent: false,
          },
        },
      });
    });
    return { tenant, stub, toolCallId, publicId, conversationPublicId: first.publicId };
  }

  // DEV_NOTE: The write action's execute (Think calls it after a wake to resume a commit), reached directly
  const runExecute = (instance: unknown, toolCallId: string) => {
    const commitChange: unknown = Reflect.get(instance as object, "commitChange");
    if (typeof commitChange !== "function") throw new Error("commitChange not found");
    return commitChange.call(instance, toolCallId) as Promise<Schemas.HostToolOutput>;
  };

  // DEV_NOTE: The Done-when's other half. An approved commit cut short by an eviction, and no widget left to send the
  // host token: the retry starts the grace (sending nothing), and once the grace has passed the change request goes to
  // a person, the host untouched.
  it("hands a commit whose widget closed to a person once the grace for the token has passed", async () => {
    const { tenant, stub, toolCallId, publicId, conversationPublicId } = await seedEntry({
      toolName: "update_record",
      args: { recordId: "rec_alpha", amount: 370 },
      stage: Schemas.ConversationChangeRequestStageEnum.Approved,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evictDurableObject(stub, { webSockets: "close" });

    // DEV_NOTE: The retry after the wake: no token, no socket. The grace starts; nothing is sent or ended.
    await runInDurableObject(stub, async (instance) => {
      await instance.retryCommits();
    });
    const waiting = (await getRuntimeState(conversationPublicId)).changeRequests[toolCallId];
    expect(waiting?.tokenNeededSince).toEqual(expect.any(Number));
    expect((await getChangeRequestRow(publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Approved,
    );

    // DEV_NOTE: The grace has passed with no widget back: handed to a person
    await runInDurableObject(stub, async (instance) => {
      const state = Schemas.ZConversationRuntimeState.parse(instance.getConfig());
      const entry = state.changeRequests[toolCallId];
      if (!entry) throw new Error("Entry gone");
      instance.configure<Schemas.ConversationRuntimeState>({
        ...state,
        changeRequests: {
          [toolCallId]: {
            ...entry,
            tokenNeededSince: Date.now() - Constants.HOST_TOKEN_GRACE_MS - 1_000,
          },
        },
      });
      await instance.retryCommits();
    });
    const row = await getChangeRequestRow(publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.NeedsHuman);
    expect(row?.errorCode).toBe(Schemas.ChangeRequestErrorCodeEnum.TokenNeeded);
    expect((await getRuntimeState(conversationPublicId)).changeRequests).toEqual({});
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(120);
  });

  // DEV_NOTE: A resume's response says it may have landed even when it sent nothing (the adapter starts a resume's
  // mayHaveLanded at true), so it must still wait for the token rather than end NeedsHuman on it
  it("keeps a Committing commit resumed with no host token waiting for one, never NeedsHuman on it", async () => {
    const { stub, toolCallId, publicId, conversationPublicId } = await seedEntry({
      toolName: "update_record",
      args: { recordId: "rec_alpha", amount: 375 },
      stage: Schemas.ConversationChangeRequestStageEnum.Committing,
    });
    const output = await runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "hostToken", null);
      return await runExecute(instance, toolCallId);
    });
    expect(output.status).toBe(Schemas.HostToolStatusEnum.Error);
    expect((await getChangeRequestRow(publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Committing,
    );
    const entry = (await getRuntimeState(conversationPublicId)).changeRequests[toolCallId];
    expect(entry?.tokenNeededSince).toEqual(expect.any(Number));
    // DEV_NOTE: The earlier attempt may have landed: its resume stays a resume
    expect(entry?.isUnsent).toBe(false);
  });

  it("asks for a fresh token when the host refuses a resumed Native commit, and creates the record once", async () => {
    const { tenant, stub, toolCallId, publicId, conversationPublicId } = await seedEntry({
      toolName: "create_record",
      args: { name: "Token Labs", email: "token@example.com", amount: 12 },
      stage: Schemas.ConversationChangeRequestStageEnum.Committing,
    });
    // DEV_NOTE: The token goes straight into memory: a host_token frame would resume the commit itself meanwhile
    const socket = await connect(tenant, { conversation: conversationPublicId });
    await setTestHostFaults(tenant.workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        method: Schemas.ToolOpMethodEnum.Post,
        status: 401,
        isApplied: false,
      },
    ]);
    const from = socket.frames.length;
    const running = runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "hostToken", tenant.hostToken);
      return await runExecute(instance, toolCallId);
    });
    await socket.waitFor(isRefresh, from);
    sendHostToken(socket, (await mintTestHostTokens(tenant.workspace)).hostToken);

    expect((await running).status).toBe(Schemas.HostToolStatusEnum.Verified);
    const row = await getChangeRequestRow(publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Verified);
    expect((await readHostRecord(tenant.hostToken, row?.hostRef ?? ""))?.data?.name).toBe(
      "Token Labs",
    );
    socket.socket.close(1000);
  });

  // DEV_NOTE: A token the host refused is dropped from memory, so the gates ask the widget for one; with no widget to
  // answer, a first send that reached nothing waits as unsent, and the next host_token sends it fresh
  it("drops a token the host refused, and sends an unsent commit fresh once a token comes back", async () => {
    const { tenant, stub, toolCallId, publicId, conversationPublicId } = await seedEntry({
      toolName: "update_record",
      args: { recordId: "rec_alpha", amount: 380 },
      stage: Schemas.ConversationChangeRequestStageEnum.Approved,
    });
    await setTestHostFaults(tenant.workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        method: Schemas.ToolOpMethodEnum.Patch,
        status: 401,
        isApplied: false,
      },
    ]);
    const heldToken = await runInDurableObject(stub, async (instance) => {
      Reflect.set(instance, "hostToken", tenant.hostToken);
      await runExecute(instance, toolCallId);
      return Reflect.get(instance, "hostToken") as unknown;
    });
    expect(heldToken).toBeNull();
    expect((await getChangeRequestRow(publicId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Committing,
    );
    expect((await getRuntimeState(conversationPublicId)).changeRequests[toolCallId]).toMatchObject({
      isUnsent: true,
      tokenNeededSince: expect.any(Number),
    });

    const socket = await connect(tenant, { conversation: conversationPublicId });
    const from = socket.frames.length;
    sendHostToken(socket, tenant.hostToken);
    await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Verified), from);
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(380);
    expect((await getRuntimeState(conversationPublicId)).changeRequests).toEqual({});
    socket.socket.close(1000);
  });
});
