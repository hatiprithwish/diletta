import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext,
  ChatResponseResult,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import type { Connection, ConnectionContext } from "agents";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import TurnBudget from "@/budget/TurnBudget";
import Constants from "@/config/Constants";
import { BudgetDO } from "@/durable-objects/BudgetDO";
import AppLogger from "@/providers/logger";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import SearchHelpDocsProvider from "@/providers/searchHelpDocs";
import TranscriptProvider from "@/providers/transcript";
import WidgetFrameProvider from "@/providers/widgetFrames";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import KnowledgeSearchRepo from "@/repositories/KnowledgeSearchRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Widget-facing texts. The reason behind each is logged, never sent.
const TURN_FAILED_MESSAGE = "Something went wrong. Please try again.";
const UNSUPPORTED_FRAME_MESSAGE = "Unsupported message";
const TURN_IN_PROGRESS_MESSAGE = "A reply is still in progress";
const CLOSING_MESSAGE = "This conversation is closing";

// DEV_NOTE: The Conversation DO (M2-2): one per conversation, named by conversations.public_id, built on Think. The
// Think session (DO SQLite) is the transcript's source of truth; messages in Neon is its read model.
//
// Trust: the widget route authenticates the companion JWT and checks the conversation is the user's own before it
// forwards the upgrade here (ADR 0001), so every socket is verified, and the session arrives in a header only the
// worker sets. Think is locked down for a public widget (pattern rule 3.23): no workspace, bash or MCP tools, no
// reasoning or identity frames, safe error text only (every model failure is a ModelUnavailableError), and every
// inbound frame goes through WidgetFrameProvider's allowlist before Think sees it. The one tool is search_help_docs
// (M2-6), active only for a bot whose config lists knowledge sources.
//
// A turn: admitted only when no other turn runs and the conversation isn't closing. Its ULID is minted and stored, and
// the activity time moves. The turn's config is checked and loaded fresh (a publish, a paused chatbot or company takes
// effect here) and the model routed through ModelRouterRepo; if either fails the message isn't saved and the widget
// gets "unavailable" (or "closed").
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
// Read model: after every turn and on every wake, the transcript past the synced position is written to messages
// (TranscriptProvider), so a failed write or a turn cut by an eviction is caught up on later.
//
// Auto-close: idle for CONVERSATION_IDLE_CLOSE_MS → Closed (Answered if any reply completed, else Abandoned). A close
// that can't act yet retries no sooner than CONVERSATION_CLOSE_RETRY_MS.
//
// Never kept here: the host bearer token (M3-8 holds it in a plain field, in memory only).
export class ConversationDO extends Think<Env> {
  static options = { sendIdentityOnConnect: false };

  workspaceBash = false;
  includeMcpTools = false;
  sendReasoning = false;
  // DEV_NOTE: Durable recovery can't resume a turn here: its config and routed model live in memory and are gone
  // after an eviction. An interrupted turn is sealed at once with safe text; the read-model sync records what was saved.
  chatRecovery = { maxAttempts: 0, terminalMessage: TURN_FAILED_MESSAGE };

  // DEV_NOTE: The turn being prepared or run: at most one. In memory only (a turn keeps the DO awake).
  private activeTurn: Schemas.ActiveTurn<LanguageModel, TurnBudget> | null = null;
  private isClosing = false;
  private syncInFlight: Promise<boolean> | null = null;
  private isSyncRequested = false;

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
    return this.activeTurn?.spec ? ConversationDO.buildInstructions(this.activeTurn.spec) : "";
  }

  // DEV_NOTE: Every turn's tool set (Think calls this at turn start). beforeTurn decides whether the tool is active.
  // The output (transcript, widget) carries citations only; toModelOutput adds the excerpts the running turn holds for
  // that call. A search from an earlier turn has none, so the model sees only what it found (SearchHelpDocsProvider).
  getTools(): ToolSet {
    return {
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
    return {
      model: turn.model,
      instructions: ConversationDO.buildInstructions(turn.spec),
      activeTools: ConversationDO.hasKnowledge(turn.spec)
        ? [Schemas.SEARCH_HELP_DOCS_TOOL_NAME]
        : [],
      maxSteps: turn.spec.limits.maxStepsPerTurn,
      stopWhen: () => caps.isExhausted(),
      timeout: { totalMs: turn.spec.limits.turnTimeoutSeconds * 1000 },
    };
  }

  // DEV_NOTE: Every wake (after hibernation or an eviction): make sure an auto-close is pending, and catch the read
  // model up in the background. onStart runs while the DO holds every other event back (blockConcurrencyWhile), so the
  // catch-up (a database write per turn) must not run inside it.
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
      });
      await this.armAutoClose();
    }

    if (this.getRuntimeState()?.isClosed) {
      this.send(connection, { type: "closed" });
      connection.close(1000, "Conversation closed");
      return;
    }

    this.send(connection, {
      type: "conversation",
      conversation: { publicId: session.conversationPublicId },
      chatbot: { publicId: session.chatbotPublicId, name: session.chatbotName },
    });
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
    if (!(await this.startTurn(ws, admission.requestId, admission.message.id))) {
      return;
    }
    try {
      await this.lifecycle.webSocketMessage(ws, admission.frame);
    } finally {
      // DEV_NOTE: Think's chat handler resolves once the turn is over. A turn it ended without calling onChatResponse or
      // onChatError (a skipped request, a failed save) is ended here, so it can't block the conversation; one that did
      // end is already released and this is a no-op.
      await this.finishTurn(admission.requestId, "error", null);
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
  // lifted and the close retried later.
  async closeIfIdle(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed || this.isClosing) return;

    const idleMs = Date.now() - state.lastActivityAt;
    if (idleMs < Constants.CONVERSATION_IDLE_CLOSE_MS || this.activeTurn) {
      this.patchRuntimeState({ closeScheduleId: null });
      await this.armAutoClose();
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
        this.send(connection, { type: "closed" });
        connection.close(1000, "Conversation closed");
      }
    } finally {
      this.isClosing = false;
    }
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
      this.reply(ws, { type: "closed" });
      ws.close(1000, "Conversation closed");
      return false;
    }
    if (this.isClosing) {
      this.reply(ws, { type: "error", message: CLOSING_MESSAGE });
      return false;
    }
    if (this.activeTurn) {
      this.reply(ws, { type: "error", message: TURN_IN_PROGRESS_MESSAGE });
      return false;
    }

    const turnId = Utility.generateUlid();
    this.activeTurn = {
      requestId,
      turnId,
      userMessageId,
      model: null,
      spec: null,
      caps: null,
      citationCount: 0,
      searchExcerpts: {},
    };
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
        this.reply(ws, { type: "closed" });
        ws.close(1000, "Conversation closed");
      } else if (prepared.refusal && Schemas.BUDGET_RATE_LIMIT_REFUSALS.has(prepared.refusal)) {
        this.reply(ws, { type: "error", message: Schemas.BUDGET_RATE_LIMIT_MESSAGE });
      } else {
        this.reply(ws, { type: "unavailable", message: Schemas.MODEL_UNAVAILABLE_MESSAGE });
      }
      return false;
    }

    this.activeTurn = {
      requestId,
      turnId,
      userMessageId,
      model: prepared.model,
      spec: prepared.spec,
      caps: prepared.caps,
      citationCount: 0,
      searchExcerpts: {},
    };
    return true;
  }

  // DEV_NOTE: The turn's config (re-checking conversation, chatbot and company), the routed model and its budget
  // admission. The conversation's own caps are checked before routing (no I/O, nothing counted); BudgetDO.admitTurn
  // and the turn-rate slot only once the model is routed, so a turn that can't run (no key, Neon down) never uses up
  // the user's message rate. isClosed when the conversation was closed elsewhere; refusal when a budget or rate limit
  // said no; otherwise a failure means the chatbot can't answer (logged by the Repos; the router opens the system
  // issue for a key failure).
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
    return { isSuccess: true, spec: config.spec, model: routed.model, caps };
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
  // stores the activity and the outcome before releasing the turn, then catches the read model up and re-arms the
  // auto-close
  private async finishTurn(
    requestId: string,
    status: ChatResponseResult["status"],
    reply: ChatResponseResult["message"] | null,
  ): Promise<void> {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    if (!turn || turn.requestId !== requestId || !state) return;

    const replyText = reply ? (TranscriptProvider.toEntries([reply])[0]?.text ?? "") : "";
    this.patchRuntimeState({
      lastActivityAt: Date.now(),
      hasAnswer: state.hasAnswer || (status === "completed" && replyText.length > 0),
    });
    this.activeTurn = null;

    await this.syncReadModel();
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

  private conversationsRepo(): ConversationsRepo {
    return new ConversationsRepo(this.env);
  }

  private send(connection: Connection, message: Schemas.WidgetServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private reply(ws: WebSocket, message: Schemas.WidgetServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // DEV_NOTE: The socket closed meanwhile: nothing left to tell it
    }
  }

  // DEV_NOTE: One knowledge search for the running turn, on the turn's config: its sources and topK. A failed search
  // (logged by the Repo) or one without a turn tells the model search is unavailable; nothing is thrown, so the turn
  // goes on.
  private async searchHelpDocs(
    query: string,
    toolCallId: string,
  ): Promise<Schemas.SearchHelpDocsOutput> {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    if (!turn?.spec || !state || !ConversationDO.hasKnowledge(turn.spec)) {
      return SearchHelpDocsProvider.unavailableOutput;
    }
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

  private static hasKnowledge(spec: Schemas.ConfigSpec): boolean {
    return spec.knowledge.sourceIds.length > 0;
  }

  // DEV_NOTE: The trusted system prompt: the company's persona, then its procedures, then how to use the help docs
  // when the bot has knowledge (M2-6). Tools (M3) add their part later.
  private static buildInstructions(spec: Schemas.ConfigSpec): string {
    const procedures = spec.procedures.map(
      (procedure) =>
        `### ${procedure.name}\nWhen to use: ${procedure.whenToUse}\nSteps:\n${procedure.steps}`,
    );
    return [
      spec.persona.instructions,
      procedures.length > 0 ? `## Procedures\n\n${procedures.join("\n\n")}` : null,
      ConversationDO.hasKnowledge(spec) ? SearchHelpDocsProvider.instructions : null,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
  }
}
