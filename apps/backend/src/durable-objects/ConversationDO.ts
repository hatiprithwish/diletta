import { Think, action } from "@cloudflare/think";
import type {
  Action,
  ChatErrorContext,
  ChatResponseResult,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import type { Connection, ConnectionContext } from "agents";
import { jsonSchema, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import TurnBudget from "@/budget/TurnBudget";
import Constants from "@/config/Constants";
import { BudgetDO } from "@/durable-objects/BudgetDO";
import HostToolCallProvider from "@/providers/hostToolCall";
import HostToolsProvider from "@/providers/hostTools";
import AppLogger from "@/providers/logger";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import SearchHelpDocsProvider from "@/providers/searchHelpDocs";
import TranscriptProvider from "@/providers/transcript";
import WidgetFrameProvider from "@/providers/widgetFrames";
import ActionEngineRepo from "@/repositories/ActionEngineRepo";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import FeedbackRepo from "@/repositories/FeedbackRepo";
import KnowledgeSearchRepo from "@/repositories/KnowledgeSearchRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Widget-facing texts. The reason behind each is logged, never sent.
const TURN_FAILED_MESSAGE = "Something went wrong. Please try again.";
const UNSUPPORTED_FRAME_MESSAGE = "Unsupported message";
const TURN_IN_PROGRESS_MESSAGE = "A reply is still in progress";
const CLOSING_MESSAGE = "This conversation is closing";
const CHANGE_NOT_WAITING_MESSAGE = "This change is no longer waiting for your answer";
const DECISION_NOT_SAVED_MESSAGE = "Your answer couldn't be saved. Please try again.";
const READ_ONLY_MESSAGE = "Changes are turned off right now";

// DEV_NOTE: Model-facing texts for host tool calls (no values, no host text)
const TOOL_TEXT = {
  unavailable: "This tool isn't available right now.",
  invalidArgs:
    "The arguments don't match the tool's input schema. Fix them and call the tool again:",
  loopGuard:
    "This exact call was already made in this turn. Don't repeat it; answer with what you have.",
  blocked: "This action isn't allowed for this user. Tell the user you can't do it.",
  pendingLimit:
    "Too many changes are already waiting for the user's approval. Ask the user to review them first.",
  tokenNeeded:
    "The app needs the user to be signed in again before this can be done. Tell the user to try again in a moment.",
  refused:
    "The app refused the request: the record may not exist, or the user may not be allowed to do this.",
  hostFailed: "The app couldn't be reached. Tell the user to try again later.",
  readOnly:
    "Changes are turned off for this app right now. Tell the user you can only look things up.",
  proposalFailed: "The change couldn't be prepared. Tell the user to try again later.",
  noChange: "The record already holds these values, so there is nothing to change.",
  nothingToDelete: "The record wasn't found, so there is nothing to delete.",
  committed: "The change was made in the app.",
  failed: "The change was not made in the app.",
  needsReview:
    "It isn't certain whether the change was made in the app; it was sent to the team for review. Tell the user plainly.",
  notWaiting: "This change is no longer waiting to be made.",
  inProgress: "This change is already being made.",
  commitPending:
    "The change was approved but couldn't be made yet; it will be tried again shortly. Tell the user it is still pending.",
  commitUnconfirmed:
    "It isn't confirmed yet whether the change was made in the app; it is being checked. Tell the user plainly.",
} as const;
const REJECTED_REASON = "The user rejected the change. Don't make it; ask what they want instead.";
const EXPIRED_REASON =
  "The change expired before the user approved it, so it wasn't made. Offer to prepare it again if they still want it.";
const SETTLED_REASON =
  "This change was already settled elsewhere. Don't make it again; tell the user to check the record.";
// DEV_NOTE: Think's answer when the pause it was asked to resolve no longer exists (approveExecution and
// rejectExecution return it instead of throwing)
const isThinkErrorResult = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "status" in result && result.status === "error";

// DEV_NOTE: The Conversation DO (M2-2): one per conversation, named by conversations.public_id, built on Think. The
// Think session (DO SQLite) is the transcript's source of truth; messages in Neon is its read model.
//
// Trust: the widget route authenticates the companion JWT and checks the conversation is the user's own before it
// forwards the upgrade here (ADR 0001), so every socket is verified, and the session arrives in a header only the
// worker sets. Think is locked down for a public widget (pattern rule 3.23): no workspace, bash or MCP tools, no
// reasoning or identity frames, safe error text only (every model failure is a ModelUnavailableError), and every
// inbound frame goes through WidgetFrameProvider's allowlist before Think sees it. Its tools are search_help_docs
// (M2-6), active only for a bot whose config lists knowledge sources, and the host tools the config pins (M3-4).
//
// A turn: admitted only when no other turn runs and the conversation isn't closing. Its ULID is minted and stored, and
// the activity time moves. The turn's config is checked and loaded fresh (a publish, a paused chatbot or company takes
// effect here), its pinned tools loaded, and the model routed through ModelRouterRepo; if any of it fails the message
// isn't saved and the widget gets "unavailable" (or "closed").
//
// Budget (M2-4): the turn must pass the conversation's own caps (conversationTurnsPerHour, conversationCostCapUsd, from
// the runtime state) before routing, and BudgetDO.admitTurn (the user's message rate, room left in the company budget
// and the user's daily cap) after it. A rate limit tells the widget to wait (BUDGET_RATE_LIMIT_MESSAGE); any other
// refusal is "unavailable"; either way nothing is saved. The admitted turn gets a TurnBudget, which the router checks
// before every model call (turn output tokens and cost, conversation cost) on top of BudgetDO's reserve, and which ends
// the turn's loop (stopWhen) once a cap is used up. turnTimeoutSeconds bounds the whole turn (AI SDK timeout).
//
// Knowledge (M2-6): search_help_docs runs KnowledgeSearchRepo on the turn's config (its sources and topK) and numbers
// the hits across the turn. The tool's output (transcript, widget) carries citations only; the excerpts stay in the
// running turn's memory and reach the model alone, inside an untrusted fence (SearchHelpDocsProvider). The read model
// keeps the citations each reply's [n] markers point at.
//
// Actions (M3-4): the config pins host tools by {name, version} (ActionEngineRepo.loadTurnTools; a read-only company
// gets no write tools). Every call's args are checked against the tool's input_schema first, and the same tool with the
// same args twice in a turn stops the turn (loop guard). A read tool calls the host (HostToolCallProvider, as the user,
// with the host token from memory) and fences what comes back (HostToolsProvider). A write tool is a Think durable-pause
// action: before it parks, its approval hook reads the record (read-before), builds the diff from the read-before and
// the real args, and stores the tool call and an encrypted change request with its event (ActionEngineRepo). When the
// user's approval is needed (HostToolsProvider.decideApproval) the turn parks: the widget gets the change_request frame,
// the change request waits CHANGE_REQUEST_APPROVAL_EXPIRY_MS (a DO schedule), and the conversation doesn't auto-close.
// The widget's change_request_decision frame approves or rejects it (an approval needs the host token: token_needed
// otherwise). An answer or the expiry claims the conversation before its first await (isDeciding, so nothing else
// starts meanwhile), is decided in the database first (which enforces the deadline), and the DO then follows the row's
// status, whoever set it. Think's approveExecution / rejectExecution resolves the pause from its own storage, so the
// pause survives an eviction, and continues the chat; the DO prepares that continuation like a turn (config, tools,
// model, budget). The action's execute commits (Approved → Committing → Committed / Failed / NeedsHuman). A commit an
// eviction or a failed write cut short is resumed (isResume) once the DO holds the host token again (the host_token
// frame, which every reconnect sends), on ACTION_COMMIT_RETRY_MS retries and on the auto-close's check. Open change
// requests live in the runtime state by Think tool call id.
//
// Read model: after every turn and on every wake, the transcript past the synced position is written to messages
// (TranscriptProvider), so a failed write or a turn cut by an eviction is caught up on later.
//
// Feedback (M2-7): the widget's feedback frame rates one reply. The read model is caught up first (the reply must be
// in messages), then FeedbackRepo stores it (a thumbs-down with its user quality issue, M2-8); the widget gets the
// stored rating back, or null when it wasn't saved.
// The ratings already given go out with the conversation frame on connect (read by the worker before the upgrade).
//
// Auto-close: idle for CONVERSATION_IDLE_CLOSE_MS with no open change request → Closed (Answered if any reply
// completed, else Abandoned). A close that can't act yet retries no sooner than CONVERSATION_CLOSE_RETRY_MS.
//
// The host bearer token lives in a plain field, in memory only: never in Think state, configure, SQLite or a log
// (pattern rule 3.11). An eviction drops it; the widget sends it again.
export class ConversationDO extends Think<Env> {
  static options = { sendIdentityOnConnect: false };

  workspaceBash = false;
  includeMcpTools = false;
  sendReasoning = false;
  // DEV_NOTE: Durable recovery can't resume a turn here: its config and routed model live in memory and are gone
  // after an eviction. An interrupted turn is sealed at once with safe text; the read-model sync records what was saved.
  chatRecovery = { maxAttempts: 0, terminalMessage: TURN_FAILED_MESSAGE };
  // DEV_NOTE: A parked approval ends by the user's answer or the expiry long before this; the sweep only bounds rows
  // whose change request ended without reaching Think (a pause found missing, a commit resumed on a wake)
  actionPendingApprovalTtlMs = Constants.ACTION_PENDING_APPROVAL_TTL_MS;

  // DEV_NOTE: The turn being prepared or run: at most one. In memory only (a turn keeps the DO awake).
  private activeTurn: Schemas.ActiveTurn<LanguageModel, TurnBudget> | null = null;
  // DEV_NOTE: An answer or an expiry being decided (before its continuation is the active turn): claimed with no await
  // after the busy check, so no turn, answer or expiry starts in between
  private isDeciding = false;
  private isClosing = false;
  private syncInFlight: Promise<boolean> | null = null;
  private isSyncRequested = false;
  private feedbackQueue: Promise<void> = Promise.resolve();
  private frameTimes: Record<"feedback" | "decision", number[]> = { feedback: [], decision: [] };
  private isFrameLimitLogged: Record<"feedback" | "decision", boolean> = {
    feedback: false,
    decision: false,
  };
  // DEV_NOTE: Never logged or persisted (pattern rule 3.11)
  private hostToken: string | null = null;
  // DEV_NOTE: A write call that ended in its approval hook without a change to make (refused, nothing to change): the
  // output its execute returns right after, by Think tool call id
  private settledCalls = new Map<string, Schemas.HostToolOutput>();
  private commitsInFlight = new Set<string>();
  // DEV_NOTE: Write calls between their cap check and their entry, counted against CHANGE_REQUEST_MAX_PENDING
  private proposalsInFlight = 0;

  getModel(): LanguageModel {
    if (!this.activeTurn?.model) {
      throw new ModelUnavailableError(
        Schemas.ModelRouterFailureEnum.ServerError,
        new Error("No routed model for this turn"),
      );
    }
    return this.activeTurn.model;
  }

  getSystemPrompt(): string {
    const turn = this.activeTurn;
    return turn?.spec ? ConversationDO.buildInstructions(turn.spec, turn.tools.length > 0) : "";
  }

  // DEV_NOTE: Every turn's tool set (Think calls this at turn start). beforeTurn decides which are active. Search: the
  // output (transcript, widget) carries citations only; toModelOutput adds the excerpts the running turn holds for that
  // call. Host reads: the output carries the host's answer, fenced for the model by toModelOutput.
  getTools(): ToolSet {
    const tools: ToolSet = {
      [Schemas.SEARCH_HELP_DOCS_TOOL_NAME]: tool({
        description: SearchHelpDocsProvider.description,
        inputSchema: Schemas.ZSearchHelpDocsInput,
        execute: async ({ query }, { toolCallId }) => await this.searchHelpDocs(query, toolCallId),
        toModelOutput: ({ toolCallId, output }) => ({
          type: "text",
          value: SearchHelpDocsProvider.toModelText(output, this.turnSearchExcerpts(toolCallId)),
        }),
      }),
    };
    for (const hostTool of this.activeTurn?.tools ?? []) {
      if (hostTool.risk !== Schemas.ToolDefinitionRiskIntEnum.Read) continue;
      tools[hostTool.name] = tool({
        description: HostToolsProvider.toolDescription(hostTool),
        inputSchema: jsonSchema<unknown>(hostTool.ops.inputSchema),
        execute: async (input, { abortSignal }) =>
          await this.runReadTool(hostTool.name, input, abortSignal),
        toModelOutput: ({ output }) => ({
          type: "text",
          value: HostToolsProvider.toModelText(output),
        }),
      });
    }
    return tools;
  }

  // DEV_NOTE: The write tools, as durable-pause actions: the running turn's, plus any tool an open change request was
  // proposed by, so Think finds its action when the user answers in a later turn (or after an eviction). A tool that
  // isn't the running turn's is never active (activeTools), so the model can't call it.
  getActions(): Record<string, Action> {
    const actions: Record<string, Action> = {};
    for (const hostTool of this.activeTurn?.tools ?? []) {
      if (hostTool.risk === Schemas.ToolDefinitionRiskIntEnum.Read) continue;
      actions[hostTool.name] = this.writeAction(
        hostTool.name,
        HostToolsProvider.toolDescription(hostTool),
        hostTool.ops.inputSchema,
      );
    }
    const entries = Object.values(this.getRuntimeState()?.changeRequests ?? {});
    for (const entry of entries) {
      if (!Object.hasOwn(actions, entry.toolName)) {
        actions[entry.toolName] = this.writeAction(entry.toolName, TOOL_TEXT.unavailable, {
          type: "object",
          properties: {},
        });
      }
    }
    return actions;
  }

  beforeTurn(_ctx: TurnContext): TurnConfig {
    const turn = this.activeTurn;
    if (!turn?.model || !turn.spec || !turn.caps) {
      throw new ModelUnavailableError(
        Schemas.ModelRouterFailureEnum.ServerError,
        new Error("Turn was not prepared"),
      );
    }
    const caps = turn.caps;
    // DEV_NOTE: The instructions come from getSystemPrompt, which Think reads for every turn
    return {
      model: turn.model,
      activeTools: [
        ...(ConversationDO.hasKnowledge(turn.spec) ? [Schemas.SEARCH_HELP_DOCS_TOOL_NAME] : []),
        ...turn.tools.map((hostTool) => hostTool.name),
      ],
      maxSteps: turn.spec.limits.maxStepsPerTurn,
      stopWhen: () => caps.isExhausted() || this.activeTurn?.isLoopStopped === true,
      timeout: { totalMs: turn.spec.limits.turnTimeoutSeconds * 1000 },
    };
  }

  // DEV_NOTE: Every wake (after hibernation or an eviction): make sure an auto-close is pending and catch the read
  // model up, in the background. onStart runs while the DO holds every other event back (blockConcurrencyWhile), so
  // database work must not run inside it. A commit an eviction cut short waits for the host token (memory only, so
  // never here on a wake): the widget's host_token frame resumes it.
  async onStart(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    if (!state.isClosed && !state.closeScheduleId) {
      await this.armAutoClose();
    }
    this.ctx.waitUntil(this.syncReadModel());
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const header = ctx.request.headers.get(Constants.CONVERSATION_SESSION_HEADER);
    const parsed = Schemas.ZConversationSession.safeParse(
      header ? Utility.parseJson(header) : null,
    );
    if (!parsed.success || parsed.data.conversationPublicId !== this.name) {
      AppLogger.error({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.FilterWidgetFrame,
        message: "Connection without a valid session for this conversation",
        metadata: { conversationPublicId: this.name },
      });
      connection.close(1008, "Not allowed");
      return;
    }
    const session = parsed.data;

    const existing = this.getRuntimeState();
    if (existing && existing.session.conversationId !== session.conversationId) {
      connection.close(1008, "Not allowed");
      return;
    }
    // DEV_NOTE: The roles of this connect's verified companion JWT and its exp (the worker's header), for the approval
    // rules; a header that doesn't parse grants none
    const rolesHeader = ctx.request.headers.get(Constants.CONVERSATION_ROLES_HEADER);
    const grant = Schemas.ZConversationRolesGrant.safeParse(
      rolesHeader ? Utility.parseJson(rolesHeader) : null,
    );
    const roles = grant.success ? grant.data : { roles: [], expiresAt: 0 };
    if (!existing) {
      this.configure<Schemas.ConversationRuntimeState>({
        session,
        lastActivityAt: Date.now(),
        hasAnswer: false,
        closeScheduleId: null,
        isClosed: false,
        lastSyncedMessageId: null,
        turnIds: {},
        lastSyncedTurnId: null,
        turnStartedAts: [],
        spentMicros: 0,
        roles: roles.roles,
        rolesExpiresAt: roles.expiresAt,
        changeRequests: {},
      });
      await this.armAutoClose();
    } else {
      this.patchRuntimeState({ roles: roles.roles, rolesExpiresAt: roles.expiresAt });
    }

    if (this.getRuntimeState()?.isClosed) {
      this.sendClosed(connection);
      return;
    }

    // DEV_NOTE: The ratings the worker read before the upgrade (Constants.CONVERSATION_FEEDBACK_HEADER), each entry
    // checked on its own, so one that doesn't parse drops only itself
    const feedbackHeader = ctx.request.headers.get(Constants.CONVERSATION_FEEDBACK_HEADER);
    const entries: unknown = feedbackHeader ? Utility.parseJson(feedbackHeader) : [];
    const feedback = (Array.isArray(entries) ? entries : []).flatMap((entry: unknown) => {
      const parsed = Schemas.ZWidgetFeedbackRating.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    this.send(connection, {
      type: "conversation",
      conversation: { publicId: session.conversationPublicId },
      chatbot: { publicId: session.chatbotPublicId, name: session.chatbotName },
      feedback,
    });

    // DEV_NOTE: The change requests still open, so a reconnecting widget can show them (a database read only when
    // there are some)
    await this.sendOpenChangeRequests(connection);
  }

  // DEV_NOTE: Every inbound frame passes here before Agents and Think see it (Agents installs its own handler only when
  // the class has none). The DO is initialized first: after a hibernation wake Think's transcript isn't loaded until
  // then, and the reused-id check below must see every stored message.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const admission = WidgetFrameProvider.admit(
      message,
      new Set(this.messages.map((stored) => stored.id)),
    );

    if (admission.kind === "refuse") {
      AppLogger.warn({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.FilterWidgetFrame,
        message: admission.reason,
        metadata: { conversationPublicId: this.name },
      });
      this.reply(ws, { type: "error", message: UNSUPPORTED_FRAME_MESSAGE });
      return;
    }
    if (admission.kind === "pass") {
      await this.lifecycle.webSocketMessage(ws, admission.frame);
      return;
    }
    if (admission.kind === "feedback") {
      await this.queueFeedback(ws, admission.messageId, admission.rating);
      return;
    }
    if (admission.kind === "hostToken") {
      this.hostToken = admission.token;
      // DEV_NOTE: A commit cut short (an eviction, a failed write) can run again now that the DO can act as the user
      this.ctx.waitUntil(this.resumeCommits());
      return;
    }
    if (admission.kind === "decision") {
      await this.decideChangeRequest(ws, admission.changeRequestPublicId, admission.decision);
      return;
    }
    if (!(await this.startTurn(ws, admission.requestId, admission.message.id))) {
      return;
    }
    try {
      await this.lifecycle.webSocketMessage(ws, admission.frame);
    } finally {
      // DEV_NOTE: Think's chat handler resolves once the turn is over. A turn it ended without calling onChatResponse or
      // onChatError (a skipped request, a failed save) is ended here, so it can't block the conversation; one that did
      // end is already released and this is a no-op. Only this request's own turn: never a continuation an answer
      // started meanwhile.
      await this.finishTurn(admission.requestId, "error", null, true);
    }
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    await this.finishTurn(result.requestId, result.status, result.message);
  }

  // DEV_NOTE: Its return value is sent to every client as the failed turn's error, so only safe text leaves. A turn
  // that failed after its user message was saved still ends (and reaches the read model).
  onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
    const isUnavailable = error instanceof ModelUnavailableError;
    AppLogger.error({
      category: Schemas.LogCategory.Conversation,
      action: Schemas.LogAction.RunTurn,
      message: "Turn failed",
      error,
      metadata: {
        conversationPublicId: this.name,
        stage: ctx?.stage ?? null,
        failure: isUnavailable ? error.failure : null,
      },
    });
    if (ctx?.requestId) {
      this.ctx.waitUntil(this.finishTurn(ctx.requestId, "error", null));
    }
    return isUnavailable ? Schemas.MODEL_UNAVAILABLE_MESSAGE : TURN_FAILED_MESSAGE;
  }

  // DEV_NOTE: Scheduled (schedule()); public because the scheduler calls it by name. Closing is marked before the first
  // await, so no message is admitted into a conversation on its way to Closed; if the database write fails the mark is
  // lifted and the close retried later. A conversation with an open change request waits (its expiry ends it first).
  async closeIfIdle(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed || this.isClosing) return;

    const idleMs = Date.now() - state.lastActivityAt;
    const hasOpenChange = Object.keys(state.changeRequests).length > 0;
    if (idleMs < Constants.CONVERSATION_IDLE_CLOSE_MS || this.isBusy() || hasOpenChange) {
      this.patchRuntimeState({ closeScheduleId: null });
      await this.armAutoClose();
      // DEV_NOTE: The open change requests' backstop: an expiry whose schedule never ran, a commit left to resume
      if (hasOpenChange) this.ctx.waitUntil(this.sweepChangeRequests());
      return;
    }

    this.isClosing = true;
    try {
      // DEV_NOTE: Never close over a read-model backlog: nothing syncs a closed conversation, so it would be lost
      if (!(await this.syncReadModel())) {
        this.patchRuntimeState({ closeScheduleId: null });
        await this.armAutoClose();
        return;
      }
      const current = this.getRuntimeState() ?? state;
      const closed = await this.conversationsRepo().closeConversation({
        session: current.session,
        outcome: current.hasAnswer
          ? Schemas.ConversationOutcomeIntEnum.Answered
          : Schemas.ConversationOutcomeIntEnum.Abandoned,
      });
      if (!closed.isSuccess && !closed.isNotFound) {
        AppLogger.error({
          category: Schemas.LogCategory.Conversation,
          action: Schemas.LogAction.CloseIdleConversation,
          message: closed.message ?? "Conversation not closed; retrying later",
          metadata: { conversationPublicId: this.name },
        });
        this.patchRuntimeState({ closeScheduleId: null });
        await this.armAutoClose();
        return;
      }

      this.patchRuntimeState({ isClosed: true, closeScheduleId: null });
      for (const connection of this.getConnections()) {
        this.sendClosed(connection);
      }
    } finally {
      this.isClosing = false;
    }
  }

  // DEV_NOTE: Scheduled at a proposal's expiry (schedule(); public because the scheduler calls it by name). A proposal
  // still Pending at its deadline ends Expired, the pause rejected so the model can say so. A turn or another decision
  // running at the deadline (or a close in progress) delays it by CONVERSATION_CLOSE_RETRY_MS; the database's own
  // deadline already refuses a late approval meanwhile.
  async expireChangeRequest(payload: { toolCallId: string }): Promise<void> {
    const entry = this.getRuntimeState()?.changeRequests[payload.toolCallId];
    if (!entry || entry.stage !== Schemas.ConversationChangeRequestStageEnum.Pending) return;
    if (Date.now() < entry.expiresAt || this.isBusy() || this.isClosing) {
      const runAt = Math.max(entry.expiresAt, Date.now() + Constants.CONVERSATION_CLOSE_RETRY_MS);
      await this.scheduleExpiry(payload.toolCallId, runAt);
      return;
    }
    this.isDeciding = true;
    try {
      await this.resolvePending(
        null,
        payload.toolCallId,
        entry,
        Schemas.ChangeRequestDecisionEnum.Reject,
        true,
      );
    } finally {
      this.isDeciding = false;
    }
  }

  // DEV_NOTE: Scheduled after a commit that couldn't start or finish its database write (public: the scheduler calls
  // it by name)
  async retryCommits(): Promise<void> {
    await this.resumeCommits();
  }

  // DEV_NOTE: Admits a new user turn: refused while the conversation is closed or closing or another turn runs. The
  // turn's ULID and the activity time are stored first (so the read model and the auto-close see this turn even if the
  // DO is evicted), then the config and the model are prepared. false = refused; the widget was told why.
  private async startTurn(
    ws: WebSocket,
    requestId: string,
    userMessageId: string,
  ): Promise<boolean> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) {
      this.sendClosed(ws);
      return false;
    }
    if (this.isClosing) {
      this.reply(ws, { type: "error", message: CLOSING_MESSAGE });
      return false;
    }
    if (this.isBusy()) {
      this.reply(ws, { type: "error", message: TURN_IN_PROGRESS_MESSAGE });
      return false;
    }

    const turnId = Utility.generateUlid();
    this.activeTurn = ConversationDO.newTurn({ requestId, turnId, userMessageId });
    this.patchRuntimeState({
      lastActivityAt: Date.now(),
      turnIds: { ...state.turnIds, [userMessageId]: turnId },
    });

    const prepared = await this.prepareTurn(state.session, turnId);
    if (!prepared.isSuccess) {
      this.activeTurn = null;
      const { [userMessageId]: _dropped, ...turnIds } = this.getRuntimeState()?.turnIds ?? {};
      this.patchRuntimeState({ turnIds });
      if (prepared.isClosed) {
        this.sendClosed(ws);
      } else if (prepared.refusal && Schemas.BUDGET_RATE_LIMIT_REFUSALS.has(prepared.refusal)) {
        this.reply(ws, { type: "error", message: Schemas.BUDGET_RATE_LIMIT_MESSAGE });
      } else {
        this.reply(ws, { type: "unavailable", message: Schemas.MODEL_UNAVAILABLE_MESSAGE });
      }
      return false;
    }

    this.activeTurn = this.preparedTurn(
      ConversationDO.newTurn({ requestId, turnId, userMessageId }),
      prepared,
    );
    return true;
  }

  // DEV_NOTE: A turn prepared for Think: its config, tools, model and budget, and whether the transcript already holds
  // untrusted content (then every write in it needs approval)
  private preparedTurn(
    turn: Schemas.ActiveTurn<LanguageModel, TurnBudget>,
    prepared: Extract<Schemas.PreparedTurn<LanguageModel, TurnBudget>, { isSuccess: true }>,
  ): Schemas.ActiveTurn<LanguageModel, TurnBudget> {
    return {
      ...turn,
      model: prepared.model,
      spec: prepared.spec,
      caps: prepared.caps,
      tools: prepared.tools,
      isUntrusted: HostToolsProvider.hasUntrustedHistory(this.messages),
    };
  }

  private static newTurn(params: {
    requestId: string;
    turnId: string;
    userMessageId: string | null;
  }): Schemas.ActiveTurn<LanguageModel, TurnBudget> {
    return {
      requestId: params.requestId,
      startedAt: Date.now(),
      turnId: params.turnId,
      userMessageId: params.userMessageId,
      isContinuation: params.userMessageId === null,
      model: null,
      spec: null,
      caps: null,
      tools: [],
      citationCount: 0,
      searchExcerpts: {},
      isUntrusted: false,
      toolCallKeys: [],
      isLoopStopped: false,
    };
  }

  // DEV_NOTE: A continuation Think never ran (or never ended) can't hold the conversation past its turn timeout
  private dropStaleContinuation(): void {
    const turn = this.activeTurn;
    if (!turn?.isContinuation) return;
    const timeoutMs = (turn.spec?.limits.turnTimeoutSeconds ?? 0) * 1000;
    if (Date.now() - turn.startedAt > timeoutMs + Constants.CONTINUATION_START_GRACE_MS) {
      AppLogger.warn({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.RunTurn,
        message: "Continuation never ended; released",
        metadata: { conversationPublicId: this.name, turnId: turn.turnId },
      });
      this.activeTurn = null;
    }
  }

  // DEV_NOTE: A turn (or a continuation) runs, or an answer or expiry is being decided: nothing else may start. Sync,
  // so a caller that finds it free claims the conversation before its first await.
  private isBusy(): boolean {
    this.dropStaleContinuation();
    return this.activeTurn !== null || this.isDeciding;
  }

  // DEV_NOTE: Per-conversation frame rate limit (in memory: an eviction resets it, which only ever allows a few more).
  // false = over the limit (logged once per burst).
  private takeFrameSlot(kind: "feedback" | "decision", limit: number): boolean {
    const now = Date.now();
    const times = this.frameTimes[kind].filter((at) => now - at < Constants.FEEDBACK_WINDOW_MS);
    if (times.length >= limit) {
      this.frameTimes[kind] = times;
      if (!this.isFrameLimitLogged[kind]) {
        this.isFrameLimitLogged[kind] = true;
        AppLogger.warn({
          category: kind === "feedback" ? Schemas.LogCategory.Feedback : Schemas.LogCategory.Action,
          action:
            kind === "feedback"
              ? Schemas.LogAction.RecordFeedback
              : Schemas.LogAction.DecideChangeRequest,
          message: `${kind === "feedback" ? "Feedback" : "Decision"} frame rate limit reached`,
          metadata: { conversationPublicId: this.name },
        });
      }
      return false;
    }
    this.isFrameLimitLogged[kind] = false;
    this.frameTimes[kind] = [...times, now];
    return true;
  }

  // DEV_NOTE: Feedback frames are rate-limited per conversation (Constants.FEEDBACK_FRAMES_PER_WINDOW, in memory: an
  // eviction resets it, which only ever allows a few more) and stored one at a time in arrival order, so a fast up →
  // down leaves the last click stored. Over the limit → "not saved" with no database work.
  private queueFeedback(
    ws: WebSocket,
    messageId: string,
    rating: Schemas.FeedbackRatingIntEnum,
  ): Promise<void> {
    if (!this.takeFrameSlot("feedback", Constants.FEEDBACK_FRAMES_PER_WINDOW)) {
      this.reply(ws, { type: "feedback", messageId, rating: null });
      return Promise.resolve();
    }

    const recorded = this.feedbackQueue.then(() => this.recordFeedback(ws, messageId, rating));
    this.feedbackQueue = recorded.catch(() => undefined);
    return recorded;
  }

  // DEV_NOTE: Stores a rating for one reply (M2-7). The read model is synced first, so a reply that just finished is in
  // messages; the running turn's reply never is (the sync leaves it out), so it can't be rated mid-stream. FeedbackRepo
  // re-checks the conversation, company and chatbot. A rating it can't match to a synced reply of this conversation, or
  // can't save, answers null; a conversation closed elsewhere also gets the closed frame.
  private async recordFeedback(
    ws: WebSocket,
    messageId: string,
    rating: Schemas.FeedbackRatingIntEnum,
  ): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed || this.isClosing) {
      this.reply(ws, { type: "feedback", messageId, rating: null });
      return;
    }
    await this.syncReadModel();
    const recorded = await new FeedbackRepo(this.env).recordFeedback({
      session: state.session,
      sessionMessageId: messageId,
      rating,
    });
    if (!recorded.isSuccess || !recorded.rating) {
      if (recorded.failure !== Schemas.RecordFeedbackFailureEnum.NotFound) {
        AppLogger.warn({
          category: Schemas.LogCategory.Feedback,
          action: Schemas.LogAction.RecordFeedback,
          message: recorded.message ?? "Feedback not saved",
          metadata: { conversationPublicId: this.name, failure: recorded.failure ?? null },
        });
      }
      this.reply(ws, { type: "feedback", messageId, rating: null });
      if (recorded.failure === Schemas.RecordFeedbackFailureEnum.ConversationClosed) {
        this.patchRuntimeState({ isClosed: true });
        this.sendClosed(ws);
      }
      return;
    }
    // DEV_NOTE: A thumbs-down's quality_issue.opened event (M2-8), relayed after the commit; the Cron sweep publishes it
    // if this relay never runs
    if (recorded.outboxId) {
      this.relayEvents([recorded.outboxId]);
    }
    this.reply(ws, { type: "feedback", messageId, rating: recorded.rating.rating });
  }

  // DEV_NOTE: The turn's config (re-checking conversation, chatbot and company), its pinned tools, the routed model and
  // its budget admission. The conversation's own caps are checked before routing (no I/O, nothing counted);
  // BudgetDO.admitTurn and the turn-rate slot only once the model is routed, so a turn that can't run (no key, Neon
  // down) never uses up the user's message rate. A read-only company's turn gets its read tools only. isClosed when the
  // conversation was closed elsewhere; refusal when a budget or rate limit said no; otherwise a failure means the
  // chatbot can't answer (logged by the Repos; the router opens the system issue for a key failure).
  private async prepareTurn(
    session: Schemas.ConversationSession,
    turnId: string,
  ): Promise<Schemas.PreparedTurn<LanguageModel, TurnBudget>> {
    const config = await this.conversationsRepo().loadTurnConfig({ session });
    if (!config.isSuccess || !config.spec) {
      const isClosed = config.failure === Schemas.TurnConfigFailureEnum.ConversationClosed;
      if (isClosed) this.patchRuntimeState({ isClosed: true });
      return { isSuccess: false, isClosed, refusal: null };
    }
    const { limits } = config.spec;

    const loadedTools = await this.actionEngineRepo().loadTurnTools({
      session,
      pins: config.spec.tools,
      isReadOnly: config.isReadOnly ?? false,
    });
    if (!loadedTools.isSuccess || !loadedTools.tools) {
      return { isSuccess: false, isClosed: false, refusal: null };
    }
    const tools = loadedTools.tools;

    const localRefusal = this.checkConversationCaps(limits);
    if (localRefusal) return this.refuseTurn(turnId, localRefusal);

    const caps = new TurnBudget({
      limits,
      getConversationSpentMicros: () => this.getRuntimeState()?.spentMicros ?? 0,
      onSpent: (costMicros) => {
        this.patchRuntimeState({
          spentMicros: (this.getRuntimeState()?.spentMicros ?? 0) + costMicros,
        });
      },
    });
    const routed = await new ModelRouterRepo(this.env, this.ctx).getModel({
      companyId: session.companyId,
      chatbotId: session.chatbotId,
      chatbotUserId: session.chatbotUserId,
      conversationId: session.conversationId,
      evalRunId: null,
      turnId,
      taskType: Schemas.ModelTaskTypeEnum.QaAnswer,
      tier: null,
      routing: config.spec.routing,
      caps,
    });
    if (!routed.isSuccess) return { isSuccess: false, isClosed: false, refusal: null };

    const budgetRefusal = await this.admitTurnBudget(session, limits);
    if (budgetRefusal) return this.refuseTurn(turnId, budgetRefusal);
    return { isSuccess: true, spec: config.spec, model: routed.model, caps, tools };
  }

  // DEV_NOTE: conversationTurnsPerHour and conversationCostCapUsd, from the runtime state. null = within both.
  private checkConversationCaps(
    limits: Schemas.ConfigSpec["limits"],
  ): Schemas.BudgetRefusalEnum | null {
    const state = this.getRuntimeState();
    if (!state) return Schemas.BudgetRefusalEnum.Unavailable;
    const now = Date.now();
    const recentTurns = state.turnStartedAts.filter(
      (startedAt) => now - startedAt < Constants.BUDGET_TURN_WINDOW_MS,
    );
    if (recentTurns.length >= limits.conversationTurnsPerHour) {
      return Schemas.BudgetRefusalEnum.ConversationTurnRate;
    }
    if (state.spentMicros >= Schemas.usdToMicros(limits.conversationCostCapUsd)) {
      return Schemas.BudgetRefusalEnum.ConversationCost;
    }
    return null;
  }

  // DEV_NOTE: BudgetDO.admitTurn (an unreachable BudgetDO refuses: fail closed); an admitted turn's start time is
  // stored for conversationTurnsPerHour. null = admitted.
  private async admitTurnBudget(
    session: Schemas.ConversationSession,
    limits: Schemas.ConfigSpec["limits"],
  ): Promise<Schemas.BudgetRefusalEnum | null> {
    let admitted: Schemas.BudgetAdmissionResponse;
    try {
      admitted = await BudgetDO.forCompany(this.env, session.companyId).admitTurn({
        companyId: session.companyId,
        chatbotUserId: session.chatbotUserId,
        userMessagesPerMinute: limits.userMessagesPerMinute,
        userDailyCostCapUsd: limits.userDailyCostCapUsd,
      });
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.AdmitBudgetTurn,
        message: "BudgetDO unreachable; turn refused",
        error,
        metadata: { conversationPublicId: this.name },
      });
      return Schemas.BudgetRefusalEnum.Unavailable;
    }
    if (!admitted.isSuccess) {
      return admitted.refusal ?? Schemas.BudgetRefusalEnum.Unavailable;
    }

    const now = Date.now();
    const current = this.getRuntimeState()?.turnStartedAts ?? [];
    this.patchRuntimeState({
      turnStartedAts: [
        ...current.filter((startedAt) => now - startedAt < Constants.BUDGET_TURN_WINDOW_MS),
        now,
      ],
    });
    return null;
  }

  private refuseTurn(
    turnId: string,
    refusal: Schemas.BudgetRefusalEnum,
  ): Schemas.PreparedTurn<LanguageModel, TurnBudget> {
    AppLogger.warn({
      category: Schemas.LogCategory.Conversation,
      action: Schemas.LogAction.RunTurn,
      message: "Turn refused by its budget",
      metadata: { conversationPublicId: this.name, turnId, refusal },
    });
    return { isSuccess: false, isClosed: false, refusal };
  }

  // DEV_NOTE: Ends the active turn once (onChatResponse, or onChatError for a turn that failed before a response):
  // stores the activity and the outcome before releasing the turn, then catches the read model up, notes the
  // execution ids of the proposals it parked and re-arms the auto-close. A continuation has Think's own request id, so
  // the first turn end Think reports while one is active is it; the DO's own fallback end of a widget request
  // (isFallback) ends only that request's turn, never a continuation an answer started meanwhile.
  private async finishTurn(
    requestId: string,
    status: ChatResponseResult["status"],
    reply: ChatResponseResult["message"] | null,
    isFallback = false,
  ): Promise<void> {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    if (!turn || !state) return;
    if (turn.requestId !== requestId && (isFallback || !turn.isContinuation)) return;

    const replyText = reply ? (TranscriptProvider.toEntries([reply])[0]?.text ?? "") : "";
    this.patchRuntimeState({
      lastActivityAt: Date.now(),
      hasAnswer: state.hasAnswer || (status === "completed" && replyText.length > 0),
    });
    this.activeTurn = null;
    // DEV_NOTE: An approval hook's outcome whose execute never ran (the turn ended in between) is dropped with the turn
    this.settledCalls.clear();

    await this.syncReadModel();
    await this.recordExecutionIds();
    await this.armAutoClose();
  }

  // DEV_NOTE: Writes the transcript past the synced position (a message id) to the read model, turn by turn, moving
  // the position only after a turn's write commits. A running turn is left out until it ends. One sync at a time: a
  // call made while one runs asks it to go round once more and waits for it, so every caller gets the outcome of a
  // sync that started after its call. Resolves true when everything is synced, false when a write failed or the
  // position isn't in the loaded transcript (logged; the next turn, wake or close retries).
  private async syncReadModel(): Promise<boolean> {
    if (this.syncInFlight) {
      this.isSyncRequested = true;
      return await this.syncInFlight;
    }
    const repo = this.conversationsRepo();
    this.syncInFlight = (async () => {
      try {
        let isSynced = true;
        do {
          this.isSyncRequested = false;
          isSynced = await this.syncOnce(repo);
        } while (this.isSyncRequested && isSynced);
        return isSynced;
      } finally {
        this.syncInFlight = null;
      }
    })();
    return await this.syncInFlight;
  }

  private async syncOnce(repo: ConversationsRepo): Promise<boolean> {
    const state = this.getRuntimeState();
    if (!state) return true;
    // DEV_NOTE: A running continuation's reply has no user message to cut the transcript at, and Think may have saved
    // part of it already: nothing is written until it ends (finishTurn syncs then)
    if (this.activeTurn?.isContinuation) return false;

    const entries = TranscriptProvider.toEntries(this.messages);
    const activeUserMessageId = this.activeTurn?.userMessageId;
    const activeIndex = activeUserMessageId
      ? entries.findIndex((entry) => entry.id === activeUserMessageId)
      : -1;
    const unsynced = TranscriptProvider.unsyncedTurns({
      entries: activeIndex >= 0 ? entries.slice(0, activeIndex) : entries,
      lastSyncedMessageId: state.lastSyncedMessageId,
      turnIds: state.turnIds,
      lastSyncedTurnId: state.lastSyncedTurnId,
      mintTurnId: () => Utility.generateUlid(),
      titleMaxChars: Constants.CONVERSATION_TITLE_MAX_CHARS,
    });
    if (unsynced.isPositionLost) {
      AppLogger.warn({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.SyncReadModel,
        message: "Last synced message isn't in the loaded transcript; sync deferred",
        metadata: { conversationPublicId: this.name, messageCount: entries.length },
      });
      return false;
    }

    for (const turn of unsynced.turns) {
      const recorded = await repo.recordTurn({
        session: state.session,
        turnId: turn.turnId,
        messages: turn.messages,
        title: turn.title,
      });
      if (!recorded.isSuccess) {
        AppLogger.error({
          category: Schemas.LogCategory.Conversation,
          action: Schemas.LogAction.SyncReadModel,
          message: recorded.message ?? "Turn not recorded in the read model; retrying later",
          metadata: { conversationPublicId: this.name, turnId: turn.turnId },
        });
        return false;
      }
      const turnIds = { ...(this.getRuntimeState()?.turnIds ?? {}) };
      if (turn.userMessageId !== null) delete turnIds[turn.userMessageId];
      this.patchRuntimeState({
        lastSyncedMessageId: turn.lastEntryId,
        lastSyncedTurnId: turn.turnId,
        turnIds,
      });
    }

    // DEV_NOTE: A turn id whose user message Think never saved (a request it skipped) is dropped, so they can't pile
    // up. Judged on the live state, not this sync's snapshot: a turn admitted while the sync was writing keeps its id.
    const current = this.getRuntimeState();
    if (current) {
      const stored = new Set(this.messages.map((message) => message.id));
      const liveUserMessageId = this.activeTurn?.userMessageId;
      const turnIds = Object.fromEntries(
        Object.entries(current.turnIds).filter(
          ([userMessageId]) => userMessageId === liveUserMessageId || stored.has(userMessageId),
        ),
      );
      this.patchRuntimeState({ turnIds });
    }
    return true;
  }

  // DEV_NOTE: One pending auto-close at a time: the previous schedule is cancelled before the new one is set. It runs
  // at the idle deadline, but never sooner than CONVERSATION_CLOSE_RETRY_MS from now, so a deadline already passed
  // (a turn still running, a failed close) can't make it fire in a loop.
  private async armAutoClose(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) return;
    const previousId = state.closeScheduleId;
    if (previousId) {
      await this.cancelSchedule(previousId);
    }
    const runAt = Math.max(
      state.lastActivityAt + Constants.CONVERSATION_IDLE_CLOSE_MS,
      Date.now() + Constants.CONVERSATION_CLOSE_RETRY_MS,
    );
    const scheduled = await this.schedule(new Date(runAt), "closeIfIdle");

    // DEV_NOTE: Another arm ran while this one awaited: keep theirs, drop ours, so one close stays pending
    const current = this.getRuntimeState();
    if (current && current.closeScheduleId !== previousId && current.closeScheduleId !== null) {
      await this.cancelSchedule(scheduled.id);
      return;
    }
    this.patchRuntimeState({ closeScheduleId: scheduled.id });
  }

  // DEV_NOTE: Read, patch and write with no await in between: a DO runs one event at a time between awaits, so a
  // patch never overwrites a change another handler made while this one was waiting on the database
  private patchRuntimeState(patch: Partial<Schemas.ConversationRuntimeState>): void {
    const current = this.getRuntimeState();
    if (!current) return;
    this.configure<Schemas.ConversationRuntimeState>({ ...current, ...patch });
  }

  private getRuntimeState(): Schemas.ConversationRuntimeState | null {
    const parsed = Schemas.ZConversationRuntimeState.safeParse(this.getConfig());
    return parsed.success ? parsed.data : null;
  }

  // DEV_NOTE: One open change request's entry, patched (or removed with null) on the live state, no await in between
  private patchChangeRequest(
    toolCallId: string,
    patch: Partial<Schemas.ConversationChangeRequestEntry> | null,
  ): void {
    const changeRequests = { ...(this.getRuntimeState()?.changeRequests ?? {}) };
    const entry = changeRequests[toolCallId];
    if (!entry) return;
    if (patch === null) {
      delete changeRequests[toolCallId];
    } else {
      changeRequests[toolCallId] = { ...entry, ...patch };
    }
    this.patchRuntimeState({ changeRequests });
  }

  private conversationsRepo(): ConversationsRepo {
    return new ConversationsRepo(this.env);
  }

  private actionEngineRepo(): ActionEngineRepo {
    return new ActionEngineRepo(this.env);
  }

  private send(connection: Connection, message: Schemas.WidgetServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  // DEV_NOTE: The conversation is closed: say so and close the socket
  private sendClosed(ws: WebSocket | Connection | null): void {
    if (!ws) return;
    this.reply(ws, { type: "closed" });
    try {
      ws.close(1000, "Conversation closed");
    } catch {
      // DEV_NOTE: Already closed
    }
  }

  private reply(ws: WebSocket | Connection | null, message: Schemas.WidgetServerMessage): void {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // DEV_NOTE: The socket closed meanwhile: nothing left to tell it
    }
  }

  private broadcastChangeRequest(changeRequest: Schemas.WidgetChangeRequest | undefined): void {
    if (!changeRequest) return;
    for (const connection of this.getConnections()) {
      this.send(connection, { type: "change_request", changeRequest });
    }
  }

  // DEV_NOTE: Critical events recorded with a step, relayed after its commit; the Cron sweep publishes any this misses
  private relayEvents(outboxIds: string[] | undefined): void {
    const state = this.getRuntimeState();
    if (!state || !outboxIds || outboxIds.length === 0) return;
    this.ctx.waitUntil(
      new EventOutboxRepo(this.env).relayEvents({
        companyId: state.session.companyId,
        outboxIds,
      }),
    );
  }

  // DEV_NOTE: One knowledge search for the running turn, on the turn's config: its sources and topK. A failed search
  // (logged by the Repo) or one without a turn tells the model search is unavailable; nothing is thrown, so the turn
  // goes on. Help docs are untrusted content: every write after a search needs approval.
  private async searchHelpDocs(
    query: string,
    toolCallId: string,
  ): Promise<Schemas.SearchHelpDocsOutput> {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    if (!turn?.spec || !state || !ConversationDO.hasKnowledge(turn.spec)) {
      return SearchHelpDocsProvider.unavailableOutput;
    }
    this.activeTurn = { ...turn, isUntrusted: true };
    const searched = await new KnowledgeSearchRepo(this.env, this.ctx).search({
      companyId: state.session.companyId,
      chatbotId: state.session.chatbotId,
      chatbotUserId: state.session.chatbotUserId,
      conversationId: state.session.conversationId,
      turnId: turn.turnId,
      sourcePublicIds: turn.spec.knowledge.sourceIds,
      topK: turn.spec.knowledge.topK,
      query,
    });
    if (!searched.isSuccess || !searched.hits) {
      return SearchHelpDocsProvider.unavailableOutput;
    }
    return this.recordSearch(turn.turnId, toolCallId, searched.hits);
  }

  // DEV_NOTE: Numbers a finished search's hits after the turn's earlier ones and keeps their excerpts for the model,
  // in one step with no await, so two searches in one step get separate numbers. The turn is replaced whole, as
  // everywhere else; a search that outlived its turn (cancelled, timed out) changes nothing.
  private recordSearch(
    turnId: string,
    toolCallId: string,
    hits: Schemas.KnowledgeSearchHit[],
  ): Schemas.SearchHelpDocsOutput {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) return SearchHelpDocsProvider.unavailableOutput;
    const excerpts = SearchHelpDocsProvider.toExcerpts(hits, turn.citationCount + 1);
    this.activeTurn = {
      ...turn,
      citationCount: turn.citationCount + excerpts.length,
      searchExcerpts: { ...turn.searchExcerpts, [toolCallId]: excerpts },
    };
    return SearchHelpDocsProvider.toOutput(excerpts);
  }

  // DEV_NOTE: The excerpts of one of the running turn's searches; undefined for an earlier turn's search
  private turnSearchExcerpts(toolCallId: string): Schemas.SearchHelpDocsExcerpt[] | undefined {
    const excerpts = this.activeTurn?.searchExcerpts;
    return excerpts && Object.hasOwn(excerpts, toolCallId) ? excerpts[toolCallId] : undefined;
  }

  // DEV_NOTE: The checks every host tool call starts with, in one step with no await: the tool is the running turn's,
  // its args fit its input_schema, and it isn't a repeat of an earlier call of the turn (the loop guard stops the turn
  // on one). A refusal is recorded as the tool call (args only when valid) and answered to the model.
  private admitHostCall(
    toolName: string,
    input: unknown,
  ):
    | {
        isAdmitted: true;
        turn: Schemas.ActiveTurn<LanguageModel, TurnBudget>;
        hostTool: Schemas.RuntimeTool;
        args: Record<string, unknown>;
        state: Schemas.ConversationRuntimeState;
      }
    | { isAdmitted: false; output: Schemas.HostToolOutput } {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    const hostTool = turn?.tools.find((candidate) => candidate.name === toolName);
    if (!turn || !state || !hostTool) {
      return {
        isAdmitted: false,
        output: HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.unavailable),
      };
    }

    const validator = Schemas.buildToolArgsValidator(hostTool.ops.inputSchema);
    const validated = validator.validator
      ? Schemas.validateToolArgs(validator.validator, hostTool.ops.inputSchema, input)
      : { isSuccess: false, issues: [validator.message ?? "input_schema can't be checked"] };
    if (!validated.isSuccess || !("args" in validated) || !validated.args) {
      this.recordToolCall(turn, state, hostTool, null, {
        status: Schemas.ToolCallStatusIntEnum.Error,
        errorCode: Schemas.ToolCallErrorCodeEnum.InvalidArgs,
      });
      const issues = (validated.issues ?? []).join("\n");
      return {
        isAdmitted: false,
        output: HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Error,
          `${TOOL_TEXT.invalidArgs}\n${issues}`,
        ),
      };
    }
    const args = validated.args;

    const key = HostToolsProvider.callKey(hostTool.name, args);
    if (turn.toolCallKeys.includes(key)) {
      this.activeTurn = { ...turn, isLoopStopped: true };
      this.recordToolCall(turn, state, hostTool, args, {
        status: Schemas.ToolCallStatusIntEnum.Blocked,
        errorCode: Schemas.ToolCallErrorCodeEnum.LoopGuard,
      });
      return {
        isAdmitted: false,
        output: HostToolsProvider.output(Schemas.HostToolStatusEnum.Blocked, TOOL_TEXT.loopGuard),
      };
    }
    const admitted = { ...turn, toolCallKeys: [...turn.toolCallKeys, key] };
    this.activeTurn = admitted;
    return { isAdmitted: true, turn: admitted, hostTool, args, state };
  }

  // DEV_NOTE: A read tool's call: the host's answer, as the user, for the model (fenced) and the transcript. Host data
  // is untrusted content: every write after it in this conversation needs approval.
  private async runReadTool(
    toolName: string,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Schemas.HostToolOutput> {
    const admitted = this.admitHostCall(toolName, input);
    if (!admitted.isAdmitted) return admitted.output;
    const { turn, hostTool, args, state } = admitted;
    this.activeTurn = { ...turn, isUntrusted: true };

    const startedAt = Date.now();
    const called = await HostToolCallProvider.read({
      tool: hostTool,
      args,
      getHostToken: () => this.hostToken,
      signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (called.outcome === Schemas.HostCallOutcomeEnum.Succeeded) {
      this.recordToolCall(turn, state, hostTool, args, {
        status: Schemas.ToolCallStatusIntEnum.Ok,
        errorCode: null,
        latencyMs,
      });
      return HostToolsProvider.readOutput(called.body);
    }
    const failed = ConversationDO.hostFailure(called.outcome);
    this.logHostCall(hostTool, called, "Host read failed");
    this.recordToolCall(turn, state, hostTool, args, {
      status: Schemas.ToolCallStatusIntEnum.Error,
      errorCode: failed.errorCode,
      latencyMs,
    });
    return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, failed.text);
  }

  // DEV_NOTE: One write tool as a Think durable-pause action. The approval hook proposes the change (true = park for the
  // user, false = run execute now: the change needs no approval, or the call ended without one). execute commits
  // whatever the change request now allows, or answers the hook's own outcome.
  private writeAction(
    toolName: string,
    description: string,
    inputSchema: Schemas.ToolInputSchema | { type: "object"; properties: Record<string, never> },
  ): Action {
    return action({
      name: toolName,
      description,
      inputSchema: jsonSchema<unknown>(inputSchema),
      kind: "durable-pause",
      timeoutMs: Constants.ACTION_COMMIT_TIMEOUT_MS,
      idempotencyKey: ({ ctx }) => `change:${ctx.toolCallId}`,
      approval: async ({ input, ctx }) => await this.proposeWrite(toolName, input, ctx.toolCallId),
      execute: async (_input, ctx) => await this.commitChange(ctx.toolCallId),
    });
  }

  // DEV_NOTE: A write call, before it parks: the shared checks, the approval decision, the open-proposal cap (calls of
  // the same step count from their check on, so parallel writes can't pass it together), the read-before (none for a
  // create), the diff from it and the real args, and the proposal stored (tool call, change request, events). Only a
  // change to make reaches the user: a write that changes nothing, or one refused on the way, settles at once with its
  // output.
  private async proposeWrite(
    toolName: string,
    input: unknown,
    toolCallId: string,
  ): Promise<boolean> {
    const settle = (status: Schemas.HostToolStatusEnum, text: string) => {
      this.settledCalls.set(toolCallId, HostToolsProvider.output(status, text));
      return false;
    };
    const admitted = this.admitHostCall(toolName, input);
    if (!admitted.isAdmitted) {
      this.settledCalls.set(toolCallId, admitted.output);
      return false;
    }
    const { turn, hostTool, args, state } = admitted;
    const readbackOp = hostTool.ops.readbackOp;
    if (!turn.spec || !readbackOp || hostTool.risk === Schemas.ToolDefinitionRiskIntEnum.Read) {
      return settle(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.unavailable);
    }

    const approval = HostToolsProvider.decideApproval({
      tool: hostTool,
      rules: turn.spec.approvalRules,
      roles: HostToolsProvider.activeRoles(state, Date.now()),
      isUntrusted: turn.isUntrusted,
    });
    if (approval === Schemas.ApprovalRuleApprovalEnum.Blocked) {
      this.recordToolCall(turn, state, hostTool, args, {
        status: Schemas.ToolCallStatusIntEnum.Blocked,
        errorCode: Schemas.ToolCallErrorCodeEnum.BlockedByPolicy,
      });
      return settle(Schemas.HostToolStatusEnum.Blocked, TOOL_TEXT.blocked);
    }
    const pendingCount = Object.values(state.changeRequests).filter(
      (entry) => entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending,
    ).length;
    if (pendingCount + this.proposalsInFlight >= Schemas.CHANGE_REQUEST_MAX_PENDING) {
      this.recordToolCall(turn, state, hostTool, args, {
        status: Schemas.ToolCallStatusIntEnum.Error,
        errorCode: Schemas.ToolCallErrorCodeEnum.PendingLimit,
      });
      return settle(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.pendingLimit);
    }

    this.proposalsInFlight += 1;
    try {
      const kind = Schemas.getChangeRequestKind(hostTool.risk, readbackOp);
      const startedAt = Date.now();
      let before: unknown = null;
      if (Schemas.hasReadBefore(kind)) {
        const read = await HostToolCallProvider.readBefore({
          tool: hostTool,
          args,
          getHostToken: () => this.hostToken,
        });
        if (read.outcome !== Schemas.HostCallOutcomeEnum.Succeeded) {
          const failed = ConversationDO.hostFailure(read.outcome);
          this.logHostCall(hostTool, read, "Read-before failed");
          this.recordToolCall(turn, state, hostTool, args, {
            status: Schemas.ToolCallStatusIntEnum.Error,
            errorCode: failed.errorCode,
            latencyMs: Date.now() - startedAt,
          });
          return settle(Schemas.HostToolStatusEnum.Error, failed.text);
        }
        before = read.body ?? null;
      }

      const changes = Schemas.buildChangeRequestChanges({
        kind,
        callOp: hostTool.ops.callOp,
        readbackOp,
        args,
        before,
      });
      if (Schemas.countChangedFields(changes) === 0) {
        this.recordToolCall(turn, state, hostTool, args, {
          status: Schemas.ToolCallStatusIntEnum.Ok,
          errorCode: Schemas.ToolCallErrorCodeEnum.NoChange,
          latencyMs: Date.now() - startedAt,
        });
        return settle(
          Schemas.HostToolStatusEnum.NoChange,
          kind === Schemas.ChangeRequestKindEnum.Delete
            ? TOOL_TEXT.nothingToDelete
            : TOOL_TEXT.noChange,
        );
      }

      const isApprovalRequired = approval === Schemas.ApprovalRuleApprovalEnum.Required;
      const proposed = await this.actionEngineRepo().proposeChange({
        session: state.session,
        turnId: turn.turnId,
        tool: hostTool,
        args,
        kind,
        before,
        changes,
        isApprovalRequired,
        hasUntrustedContext: turn.isUntrusted,
        latencyMs: Date.now() - startedAt,
      });
      if (!proposed.isSuccess || !proposed.changeRequest) {
        AppLogger.error({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.ProposeChange,
          message: proposed.message ?? "Change not proposed",
          metadata: {
            conversationPublicId: this.name,
            toolName,
            failure: proposed.failure ?? null,
          },
        });
        return settle(
          Schemas.HostToolStatusEnum.Error,
          proposed.failure === Schemas.ChangeRequestFailureEnum.ReadOnly
            ? TOOL_TEXT.readOnly
            : TOOL_TEXT.proposalFailed,
        );
      }
      const { changeRequest } = proposed;
      this.relayEvents(proposed.outboxIds);

      const expiresAt =
        changeRequest.expiresAt ?? Date.now() + Schemas.CHANGE_REQUEST_APPROVAL_EXPIRY_MS;
      const changeRequests = { ...(this.getRuntimeState()?.changeRequests ?? {}) };
      changeRequests[toolCallId] = {
        publicId: changeRequest.publicId,
        toolName,
        turnId: turn.turnId,
        stage: isApprovalRequired
          ? Schemas.ConversationChangeRequestStageEnum.Pending
          : Schemas.ConversationChangeRequestStageEnum.Approved,
        expiresAt,
        executionId: null,
        expiryScheduleId: null,
      };
      this.patchRuntimeState({ changeRequests });
      this.broadcastChangeRequest(changeRequest);

      if (!isApprovalRequired) return false;
      await this.scheduleExpiry(toolCallId, expiresAt);
      return true;
    } finally {
      this.proposalsInFlight -= 1;
    }
  }

  // DEV_NOTE: A Pending entry's expiry schedule (replacing the one it had). A schedule that can't be set is logged and
  // left to the auto-close's sweep, which expires an overdue entry.
  private async scheduleExpiry(toolCallId: string, runAt: number): Promise<void> {
    try {
      const scheduled = await this.schedule(new Date(runAt), "expireChangeRequest", { toolCallId });
      this.patchChangeRequest(toolCallId, { expiryScheduleId: scheduled.id });
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.ExpireChangeRequest,
        message: "Expiry not scheduled; the auto-close check expires it",
        error,
        metadata: { conversationPublicId: this.name },
      });
    }
  }

  private async cancelExpiry(entry: Schemas.ConversationChangeRequestEntry): Promise<void> {
    if (!entry.expiryScheduleId) return;
    try {
      await this.cancelSchedule(entry.expiryScheduleId);
    } catch {
      // DEV_NOTE: A stale expiry finds no Pending entry and does nothing
    }
  }

  // DEV_NOTE: A write action's execute: the hook's own outcome when the call settled there, else the commit of its
  // change request (approved by the user or needing no approval)
  private async commitChange(toolCallId: string): Promise<Schemas.HostToolOutput> {
    const settled = this.settledCalls.get(toolCallId);
    if (settled) {
      this.settledCalls.delete(toolCallId);
      return settled;
    }
    const entry = this.getRuntimeState()?.changeRequests[toolCallId];
    if (!entry || entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending) {
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.notWaiting);
    }
    return await this.runCommit(toolCallId, entry);
  }

  // DEV_NOTE: The commit: Committing (its key stored first), the host write as the user, and the end status. Anything
  // that leaves the outcome unrecorded keeps the entry and is tried again (ACTION_COMMIT_RETRY_MS, the next host_token
  // frame, the auto-close check) rather than losing what may have landed: a database step that failed, or a resume with
  // no host token yet (nothing sent; it waits for the token instead of ending NeedsHuman).
  private async runCommit(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
  ): Promise<Schemas.HostToolOutput> {
    const state = this.getRuntimeState();
    if (!state)
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.unavailable);
    if (this.commitsInFlight.has(entry.publicId)) {
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.inProgress);
    }
    this.commitsInFlight.add(entry.publicId);
    try {
      this.patchChangeRequest(toolCallId, {
        stage: Schemas.ConversationChangeRequestStageEnum.Committing,
      });
      const repo = this.actionEngineRepo();
      const started = await repo.startCommit({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        attemptId: Utility.generateUlid(),
      });
      this.relayEvents(started.outboxIds);
      this.broadcastChangeRequest(started.changeRequest);
      if (!started.isSuccess || !started.plan) {
        return await this.endUnstartedCommit(toolCallId, entry, started);
      }

      const committed = await HostToolCallProvider.commit({
        plan: started.plan,
        getHostToken: () => this.hostToken,
      });
      if (
        committed.outcome !== Schemas.HostCallOutcomeEnum.Succeeded &&
        committed.outcome !== Schemas.HostCallOutcomeEnum.AlreadyApplied
      ) {
        this.logHostCall(started.plan.tool, committed, "Commit didn't succeed");
      }
      // DEV_NOTE: A resume that couldn't even be sent for want of the token stays Committing until the token comes back
      if (
        started.plan.isResume &&
        committed.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded &&
        committed.attempts === 0
      ) {
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Error,
          TOOL_TEXT.commitUnconfirmed,
          entry.publicId,
        );
      }

      const finished = await repo.finishCommit({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        hostCall: committed,
        isResume: started.plan.isResume,
      });
      this.relayEvents(finished.outboxIds);
      this.broadcastChangeRequest(finished.changeRequest);
      if (
        finished.changeRequest &&
        finished.failure !== Schemas.ChangeRequestFailureEnum.ServerError
      ) {
        this.patchChangeRequest(toolCallId, null);
        return ConversationDO.commitOutput(
          entry.publicId,
          finished.changeRequest.changeRequestStatus,
        );
      }
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.CommitChangeRequest,
        message: finished.message ?? "Commit end not recorded; resumed later",
        metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
      });
      if (finished.failure === Schemas.ChangeRequestFailureEnum.NotFound) {
        this.patchChangeRequest(toolCallId, null);
      } else {
        await this.scheduleCommitRetry();
      }
      return HostToolsProvider.output(
        Schemas.HostToolStatusEnum.NeedsReview,
        TOOL_TEXT.commitUnconfirmed,
        entry.publicId,
      );
    } finally {
      this.commitsInFlight.delete(entry.publicId);
    }
  }

  // DEV_NOTE: startCommit didn't hand back a plan. A row it settled (ended Failed / NeedsHuman, or found already past
  // Committing) ends the entry with that outcome; a missing row ends it; a failed database step keeps it for a retry,
  // and the model hears the change is still pending, never that it failed.
  private async endUnstartedCommit(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    started: Schemas.StartCommitResponse,
  ): Promise<Schemas.HostToolOutput> {
    if (
      started.failure === Schemas.ChangeRequestFailureEnum.ServerError &&
      !started.changeRequest
    ) {
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.CommitChangeRequest,
        message: started.message ?? "Commit not started; retried later",
        metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
      });
      await this.scheduleCommitRetry();
      return HostToolsProvider.output(
        Schemas.HostToolStatusEnum.Error,
        TOOL_TEXT.commitPending,
        entry.publicId,
      );
    }
    this.patchChangeRequest(toolCallId, null);
    const status = started.changeRequest?.changeRequestStatus;
    if (status === undefined) {
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.notWaiting);
    }
    return ConversationDO.commitOutput(entry.publicId, status);
  }

  private async scheduleCommitRetry(): Promise<void> {
    try {
      await this.schedule(new Date(Date.now() + Constants.ACTION_COMMIT_RETRY_MS), "retryCommits");
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.CommitChangeRequest,
        message: "Commit retry not scheduled; the next host token or auto-close check resumes it",
        error,
        metadata: { conversationPublicId: this.name },
      });
    }
  }

  private static commitOutput(
    changeRequestPublicId: string,
    status: Schemas.ChangeRequestStatusIntEnum | undefined,
  ): Schemas.HostToolOutput {
    switch (status) {
      case Schemas.ChangeRequestStatusIntEnum.Committed:
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Committed,
          TOOL_TEXT.committed,
          changeRequestPublicId,
        );
      case Schemas.ChangeRequestStatusIntEnum.NeedsHuman:
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.NeedsReview,
          TOOL_TEXT.needsReview,
          changeRequestPublicId,
        );
      default:
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Failed,
          TOOL_TEXT.failed,
          changeRequestPublicId,
        );
    }
  }

  // DEV_NOTE: The widget's answer to a proposal. Rate-limited per conversation (DECISION_FRAMES_PER_WINDOW) before any
  // database work. Only a Pending one of this conversation is decided; anything else gets the change request as it
  // stands. One at a time: the answer continues the chat, so it waits for a running turn or decision, and claims the
  // conversation (isDeciding) with no await after that check. An approval needs the host token (the commit runs as
  // the user): without one the widget gets token_needed and the proposal keeps waiting.
  private async decideChangeRequest(
    ws: WebSocket,
    changeRequestPublicId: string,
    decision: Schemas.ChangeRequestDecisionEnum,
  ): Promise<void> {
    if (!this.takeFrameSlot("decision", Constants.DECISION_FRAMES_PER_WINDOW)) {
      this.reply(ws, { type: "error", message: DECISION_NOT_SAVED_MESSAGE });
      return;
    }
    const state = this.getRuntimeState();
    if (!state || state.isClosed) {
      this.sendClosed(ws);
      return;
    }
    const found = Object.entries(state.changeRequests).find(
      ([, entry]) => entry.publicId === changeRequestPublicId,
    );
    if (!found || found[1].stage !== Schemas.ConversationChangeRequestStageEnum.Pending) {
      const views = await this.actionEngineRepo().getChangeRequestViews({
        session: state.session,
        changeRequestPublicIds: [changeRequestPublicId],
      });
      const view = views.changeRequests?.[0];
      if (view) this.reply(ws, { type: "change_request", changeRequest: view });
      this.reply(ws, { type: "error", message: CHANGE_NOT_WAITING_MESSAGE });
      return;
    }
    if (this.isClosing) {
      this.reply(ws, { type: "error", message: CLOSING_MESSAGE });
      return;
    }
    if (this.isBusy()) {
      this.reply(ws, { type: "error", message: TURN_IN_PROGRESS_MESSAGE });
      return;
    }
    if (decision === Schemas.ChangeRequestDecisionEnum.Approve && !this.hostToken) {
      this.reply(ws, { type: "token_needed" });
      return;
    }
    const [toolCallId, entry] = found;
    this.isDeciding = true;
    try {
      this.patchRuntimeState({ lastActivityAt: Date.now() });
      await this.resolvePending(ws, toolCallId, entry, decision, false);
    } finally {
      this.isDeciding = false;
    }
  }

  // DEV_NOTE: Ends a Pending proposal: the user's answer or its expiry, with the conversation claimed (isDeciding) by
  // the caller. The database decides first (rule 3.23 re-checks; an approval after the deadline ends Expired), so a
  // refused decision spends no budget. Then the DO follows the row's status, whoever set it (a lost race, an answer
  // whose response never arrived): Approved → the commit; Committing → left for the commit already under way (or its
  // resume); any end status → the entry goes and a pause Think still holds is rejected so the model hears why. A
  // refusal that settled nothing keeps the proposal (an expiry is tried again on a database failure).
  private async resolvePending(
    ws: WebSocket | null,
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    decision: Schemas.ChangeRequestDecisionEnum,
    isExpired: boolean,
  ): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    const logAction = isExpired
      ? Schemas.LogAction.ExpireChangeRequest
      : Schemas.LogAction.DecideChangeRequest;

    const decided = await this.actionEngineRepo().decideChangeRequest({
      session: state.session,
      changeRequestPublicId: entry.publicId,
      decision,
      isExpired,
    });
    this.relayEvents(decided.outboxIds);
    this.broadcastChangeRequest(decided.changeRequest);
    const status = decided.changeRequest?.changeRequestStatus;

    if (status === undefined || status === Schemas.ChangeRequestStatusIntEnum.Proposed) {
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: logAction,
        message: decided.message ?? "Change request not decided",
        metadata: { conversationPublicId: this.name, failure: decided.failure ?? null },
      });
      await this.keepUndecided(ws, toolCallId, entry, decided.failure, isExpired);
      return;
    }

    const expected = isExpired
      ? Schemas.ChangeRequestStatusIntEnum.Expired
      : decision === Schemas.ChangeRequestDecisionEnum.Approve
        ? Schemas.ChangeRequestStatusIntEnum.Approved
        : Schemas.ChangeRequestStatusIntEnum.Rejected;
    if (status !== expected) {
      this.reply(ws, { type: "error", message: CHANGE_NOT_WAITING_MESSAGE });
    }
    await this.cancelExpiry(entry);
    if (status === Schemas.ChangeRequestStatusIntEnum.Committing) {
      this.patchChangeRequest(toolCallId, {
        stage: Schemas.ConversationChangeRequestStageEnum.Committing,
        expiryScheduleId: null,
      });
      return;
    }
    const isApproved = status === Schemas.ChangeRequestStatusIntEnum.Approved;
    this.patchChangeRequest(
      toolCallId,
      isApproved
        ? { stage: Schemas.ConversationChangeRequestStageEnum.Approved, expiryScheduleId: null }
        : null,
    );
    await this.resolvePause(toolCallId, entry, status);
  }

  // DEV_NOTE: A decision that settled nothing: the widget hears why; a change request that no longer exists drops its
  // entry; a failed expiry is tried again; a closed conversation is closed here too (the expiry still ends the entry)
  private async keepUndecided(
    ws: WebSocket | null,
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    failure: Schemas.ChangeRequestFailureEnum | undefined,
    isExpired: boolean,
  ): Promise<void> {
    if (failure === Schemas.ChangeRequestFailureEnum.NotFound) {
      await this.cancelExpiry(entry);
      this.patchChangeRequest(toolCallId, null);
      this.reply(ws, { type: "error", message: CHANGE_NOT_WAITING_MESSAGE });
      return;
    }
    if (failure === Schemas.ChangeRequestFailureEnum.ConversationClosed) {
      this.patchRuntimeState({ isClosed: true });
      this.sendClosed(ws);
    } else if (failure === Schemas.ChangeRequestFailureEnum.ReadOnly) {
      this.reply(ws, { type: "error", message: READ_ONLY_MESSAGE });
    } else if (failure === Schemas.ChangeRequestFailureEnum.ChatbotUnavailable) {
      this.reply(ws, { type: "unavailable", message: Schemas.MODEL_UNAVAILABLE_MESSAGE });
    } else {
      this.reply(ws, { type: "error", message: DECISION_NOT_SAVED_MESSAGE });
    }
    if (isExpired) {
      await this.scheduleExpiry(toolCallId, Date.now() + Constants.CONVERSATION_CLOSE_RETRY_MS);
    }
  }

  // DEV_NOTE: Resolves Think's pause for a decided change request: approveExecution runs the action's execute (the
  // commit) and continues the chat, rejectExecution tells the model why. The continuation is prepared like a turn
  // first (it continues the proposing turn, under the last synced turn's id); one that can't be prepared (budget, no
  // key) still resolves the pause, and its turn ends with the generic safe text. A closed conversation gets no
  // continuation (its pause is left to Think's sweep). A pause Think no longer holds (swept, resolved elsewhere) is
  // committed here without a continuation when approved.
  private async resolvePause(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    status: Schemas.ChangeRequestStatusIntEnum,
  ): Promise<void> {
    const isApproved = status === Schemas.ChangeRequestStatusIntEnum.Approved;
    const executionId = await this.findExecutionId(toolCallId);
    if (!executionId) {
      this.commitWithoutPause(toolCallId, entry, isApproved);
      return;
    }

    const state = this.getRuntimeState();
    if (!state) return;
    await this.syncReadModel();
    const turnId = this.getRuntimeState()?.lastSyncedTurnId ?? entry.turnId;
    const continuation = ConversationDO.newTurn({ requestId: "", turnId, userMessageId: null });
    const prepared = await this.prepareTurn(state.session, turnId);
    if (!prepared.isSuccess && prepared.isClosed) {
      if (isApproved) this.commitWithoutPause(toolCallId, entry, true);
      return;
    }
    if (prepared.isSuccess) {
      this.activeTurn = this.preparedTurn(continuation, prepared);
    } else {
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.DecideChangeRequest,
        message: "Continuation not prepared; the pause is resolved without one",
        metadata: { conversationPublicId: this.name, refusal: prepared.refusal },
      });
    }
    const claimed = this.activeTurn;

    let result: unknown;
    try {
      result = isApproved
        ? await this.approveExecution(executionId)
        : await this.rejectExecution(executionId, ConversationDO.rejectionReason(status));
    } catch (error) {
      result = { status: "error" };
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.DecideChangeRequest,
        message: "Think couldn't resolve the pause",
        error,
        metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
      });
    }
    if (isThinkErrorResult(result)) {
      // DEV_NOTE: No continuation will run for a pause Think didn't resolve
      if (claimed && this.activeTurn === claimed) this.activeTurn = null;
      this.commitWithoutPause(toolCallId, entry, isApproved);
    }
  }

  // DEV_NOTE: An approved change whose pause Think doesn't hold (or couldn't resolve) is committed here, its outcome
  // reaching the widget; the model mentions it at the next message
  private commitWithoutPause(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    isApproved: boolean,
  ): void {
    AppLogger.warn({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.DecideChangeRequest,
      message: "Think holds no pause for this change request; resolved without a continuation",
      metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
    });
    const approved = this.getRuntimeState()?.changeRequests[toolCallId];
    if (isApproved && approved && !this.commitsInFlight.has(approved.publicId)) {
      this.ctx.waitUntil(this.runCommit(toolCallId, approved));
    }
  }

  private static rejectionReason(status: Schemas.ChangeRequestStatusIntEnum): string {
    switch (status) {
      case Schemas.ChangeRequestStatusIntEnum.Rejected:
        return REJECTED_REASON;
      case Schemas.ChangeRequestStatusIntEnum.Expired:
        return EXPIRED_REASON;
      default:
        return SETTLED_REASON;
    }
  }

  // DEV_NOTE: Think's durable-pause id of a parked proposal, read from its own pending approvals by tool call id (never
  // a cached id: Think may have swept or resolved it)
  private async findExecutionId(toolCallId: string): Promise<string | null> {
    const pending = await this.pendingApprovals();
    return ConversationDO.findPendingExecutionId(pending, toolCallId);
  }

  private static findPendingExecutionId(
    pending: Awaited<ReturnType<ConversationDO["pendingApprovals"]>>,
    toolCallId: string,
  ): string | null {
    const match = pending.find(
      (approval) => approval.source === "action" && approval.descriptor.toolCallId === toolCallId,
    );
    return match?.executionId ?? null;
  }

  // DEV_NOTE: After a turn parks, its proposals' execution ids go into change_requests (think_execution_id), so an
  // operator can match a pause to its row, and into the runtime state
  private async recordExecutionIds(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    const missing = Object.entries(state.changeRequests).filter(
      ([, entry]) =>
        entry.executionId === null &&
        entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending,
    );
    if (missing.length === 0) return;
    const pending = await this.pendingApprovals();
    const repo = this.actionEngineRepo();
    for (const [toolCallId, entry] of missing) {
      const executionId = ConversationDO.findPendingExecutionId(pending, toolCallId);
      if (!executionId) continue;
      const updated = await repo.setExecutionId({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        thinkExecutionId: executionId,
      });
      if (!updated.isSuccess) {
        AppLogger.warn({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.SetChangeRequestExecutionId,
          message: updated.message ?? "Execution id not stored",
          metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
        });
      }
      this.patchChangeRequest(toolCallId, { executionId });
    }
  }

  // DEV_NOTE: Runs again an approved change whose commit never started or never recorded its end (startCommit marks a
  // Committing one isResume, so a write that may have landed is never sent fresh). Only with the host token: v1's one
  // auth strategy (jwt_forward) sends the user's own token, which a wake never has until the widget sends it again.
  // Its outcome reaches the widget; the paused transcript part stays as Think left it.
  private async resumeCommits(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed || !this.hostToken) return;
    for (const [toolCallId, entry] of Object.entries(state.changeRequests)) {
      if (entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending) continue;
      if (this.commitsInFlight.has(entry.publicId)) continue;
      await this.runCommit(toolCallId, entry);
    }
  }

  // DEV_NOTE: The auto-close's check while change requests are open: an expiry whose schedule never ran (past its
  // deadline by more than a retry) is run now, and approved commits are resumed
  private async sweepChangeRequests(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    const overdueAt = Date.now() - Constants.CONVERSATION_CLOSE_RETRY_MS;
    for (const [toolCallId, entry] of Object.entries(state.changeRequests)) {
      if (
        entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending &&
        entry.expiresAt < overdueAt
      ) {
        await this.expireChangeRequest({ toolCallId });
      }
    }
    await this.resumeCommits();
  }

  // DEV_NOTE: The open change requests as they stand, to one socket (on connect)
  private async sendOpenChangeRequests(connection: Connection): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    const publicIds = Object.values(state.changeRequests).map((entry) => entry.publicId);
    if (publicIds.length === 0) return;
    const views = await this.actionEngineRepo().getChangeRequestViews({
      session: state.session,
      changeRequestPublicIds: publicIds,
    });
    for (const changeRequest of views.changeRequests ?? []) {
      this.send(connection, { type: "change_request", changeRequest });
    }
  }

  // DEV_NOTE: A host tool call into tool_calls, in waitUntil (low-stakes telemetry: a lost row loses no state)
  private recordToolCall(
    turn: Schemas.ActiveTurn<LanguageModel, TurnBudget>,
    state: Schemas.ConversationRuntimeState,
    hostTool: Schemas.RuntimeTool,
    args: Record<string, unknown> | null,
    result: {
      status: Schemas.ToolCallStatusIntEnum;
      errorCode: Schemas.ToolCallErrorCodeEnum | null;
      latencyMs?: number;
    },
  ): void {
    this.ctx.waitUntil(
      this.actionEngineRepo().recordToolCall({
        session: state.session,
        turnId: turn.turnId,
        tool: hostTool,
        args,
        status: result.status,
        errorCode: result.errorCode,
        latencyMs: result.latencyMs ?? null,
        hasUntrustedContext: turn.isUntrusted,
      }),
    );
  }

  private logHostCall(
    hostTool: Schemas.RuntimeTool,
    called: Schemas.HostCallResponse,
    message: string,
  ): void {
    AppLogger.warn({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.RunHostTool,
      message,
      metadata: {
        conversationPublicId: this.name,
        toolName: hostTool.name,
        toolVersion: hostTool.version,
        outcome: called.outcome,
        httpStatus: called.httpStatus ?? null,
        attempts: called.attempts,
      },
    });
  }

  // DEV_NOTE: A host call that didn't succeed: its tool_calls error code and what the model is told
  private static hostFailure(outcome: Schemas.HostCallOutcomeEnum): {
    errorCode: Schemas.ToolCallErrorCodeEnum;
    text: string;
  } {
    if (outcome === Schemas.HostCallOutcomeEnum.TokenNeeded) {
      return { errorCode: Schemas.ToolCallErrorCodeEnum.TokenNeeded, text: TOOL_TEXT.tokenNeeded };
    }
    if (outcome === Schemas.HostCallOutcomeEnum.TokenRejected) {
      return {
        errorCode: Schemas.ToolCallErrorCodeEnum.TokenRejected,
        text: TOOL_TEXT.tokenNeeded,
      };
    }
    if (outcome === Schemas.HostCallOutcomeEnum.Refused) {
      return { errorCode: Schemas.ToolCallErrorCodeEnum.HostRefused, text: TOOL_TEXT.refused };
    }
    return { errorCode: Schemas.ToolCallErrorCodeEnum.HostFailed, text: TOOL_TEXT.hostFailed };
  }

  private static hasKnowledge(spec: Schemas.ConfigSpec): boolean {
    return spec.knowledge.sourceIds.length > 0;
  }

  // DEV_NOTE: The trusted system prompt: the company's persona, then its procedures, then how to use the help docs
  // when the bot has knowledge (M2-6), then how to act in the user's app when the turn has host tools (M3-4)
  private static buildInstructions(spec: Schemas.ConfigSpec, hasHostTools: boolean): string {
    const procedures = spec.procedures.map(
      (procedure) =>
        `### ${procedure.name}\nWhen to use: ${procedure.whenToUse}\nSteps:\n${procedure.steps}`,
    );
    return [
      spec.persona.instructions,
      procedures.length > 0 ? `## Procedures\n\n${procedures.join("\n\n")}` : null,
      ConversationDO.hasKnowledge(spec) ? SearchHelpDocsProvider.instructions : null,
      hasHostTools ? HostToolsProvider.instructions : null,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
  }
}
