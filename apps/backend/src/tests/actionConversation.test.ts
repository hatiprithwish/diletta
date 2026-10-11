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
import worker from "@/index";
import ActionEngineRepo from "@/repositories/ActionEngineRepo";
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
  return { ...tenant, hostToken };
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
        20_000,
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
      await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Committed), from),
    );
    expect(committed.publicId).toBe(proposed.publicId);
    await second.waitFor(isContinuationDone, from);

    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(300);
    const row = await getChangeRequestRow(proposed.publicId);
    expect(row?.status).toBe(Schemas.ChangeRequestStatusIntEnum.Committed);
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
    ]);
    expect(events[1]?.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.ChatbotUser);

    // DEV_NOTE: The model's continuation saw the commit's outcome; the open change request is gone from the DO
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The change was made in the app.",
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
        readbackOp: updateTool.ops.readbackOp,
        args,
        before,
      }),
      isApprovalRequired: true,
      hasUntrustedContext: false,
      latencyMs: 1,
      expiresAt: Date.now() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS,
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
    await second.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Committed), from);
    await second.waitFor(isContinuationDone, from);

    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(250);
    expect((await getChangeRequestRow(proposedId))?.status).toBe(
      Schemas.ChangeRequestStatusIntEnum.Committed,
    );
    const pending = await runInDurableObject(
      stub,
      async (instance) => await instance.pendingApprovals(),
    );
    expect(pending).toEqual([]);
    expect(JSON.stringify(gatewayRequests().at(-1)?.body?.messages)).toContain(
      "The change was made in the app.",
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
      await socket.waitFor(changeRequestFrame(Schemas.ChangeRequestStatusIntEnum.Committed)),
    );
    expect(committed.toolName).toBe("update_record");
    expect((await readHostRecord(tenant.hostToken, "rec_alpha"))?.data?.amount).toBe(64);
    expect(JSON.stringify(gatewayRequests()[1]?.body?.messages)).toContain(
      "The change was made in the app.",
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
