import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext,
  ChatResponseResult,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import type { Connection, ConnectionContext } from "agents";
import type { LanguageModel } from "ai";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import TranscriptProvider from "@/providers/transcript";
import WidgetFrameProvider from "@/providers/widgetFrames";
import ConversationsRepo from "@/repositories/ConversationsRepo";
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
// worker sets. Think is locked down for a public widget (pattern rule 3.23): no workspace, bash, MCP or other tools,
// no reasoning or identity frames, safe error text only (every model failure is a ModelUnavailableError), and every
// inbound frame goes through WidgetFrameProvider's allowlist before Think sees it.
//
// A turn: admitted only when no other turn runs and the conversation isn't closing. Its ULID is minted and stored, and
// the activity time moves. The turn's config is checked and loaded fresh (a publish, a paused chatbot or company takes
// effect here) and the model routed through ModelRouterRepo; if either fails the message isn't saved and the widget
// gets "unavailable" (or "closed").
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
  private activeTurn: {
    requestId: string;
    turnId: string;
    userMessageId: string;
    model: LanguageModel | null;
    spec: Schemas.ConfigSpec | null;
  } | null = null;
  private isClosing = false;
  private isSyncing = false;
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

  beforeTurn(_ctx: TurnContext): TurnConfig {
    const turn = this.activeTurn;
    if (!turn?.model || !turn.spec) {
      throw new ModelUnavailableError(
        Schemas.ModelRouterFailureEnum.ServerError,
        new Error("Turn was not prepared"),
      );
    }
    return {
      model: turn.model,
      instructions: ConversationDO.buildInstructions(turn.spec),
      activeTools: [],
      maxSteps: turn.spec.limits.maxStepsPerTurn,
    };
  }

  // DEV_NOTE: Every wake (after hibernation or an eviction): catch the read model up, and make sure an auto-close is
  // pending
  async onStart(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) return;
    await this.syncReadModel();
    if (!state.closeScheduleId) {
      await this.armAutoClose();
    }
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
        syncedMessageCount: 0,
        turnIds: {},
        lastSyncedTurnId: null,
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
  // the class has none)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
    if (await this.startTurn(ws, admission.requestId, admission.message.id)) {
      await this.lifecycle.webSocketMessage(ws, admission.frame);
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
      await this.syncReadModel();
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
    this.activeTurn = { requestId, turnId, userMessageId, model: null, spec: null };
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
    };
    return true;
  }

  // DEV_NOTE: The turn's config (re-checking conversation, chatbot and company) and the routed model. isClosed when the
  // conversation was closed elsewhere; otherwise a failure means the chatbot can't answer (logged by the Repos; the
  // router opens the system issue for a key failure).
  private async prepareTurn(
    session: Schemas.ConversationSession,
    turnId: string,
  ): Promise<
    | { isSuccess: true; spec: Schemas.ConfigSpec; model: LanguageModel }
    | { isSuccess: false; isClosed: boolean }
  > {
    const config = await this.conversationsRepo().loadTurnConfig({ session });
    if (!config.isSuccess || !config.spec) {
      const isClosed = config.failure === Schemas.TurnConfigFailureEnum.ConversationClosed;
      if (isClosed) this.patchRuntimeState({ isClosed: true });
      return { isSuccess: false, isClosed };
    }

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
    });
    if (!routed.isSuccess) return { isSuccess: false, isClosed: false };
    return { isSuccess: true, spec: config.spec, model: routed.model };
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

  // DEV_NOTE: Writes the transcript past the synced position to the read model, turn by turn, advancing the position
  // only after a turn's write commits; a failure stops here and the next turn or wake retries. A running turn is left
  // out until it ends. One sync at a time; a call made meanwhile runs once more after it.
  private async syncReadModel(): Promise<void> {
    if (this.isSyncing) {
      this.isSyncRequested = true;
      return;
    }
    this.isSyncing = true;
    try {
      do {
        this.isSyncRequested = false;
        const state = this.getRuntimeState();
        if (!state) return;

        const entries = TranscriptProvider.toEntries(this.messages);
        const activeUserMessageId = this.activeTurn?.userMessageId;
        const activeIndex = activeUserMessageId
          ? entries.findIndex((entry) => entry.id === activeUserMessageId)
          : -1;
        const turns = TranscriptProvider.unsyncedTurns({
          entries: activeIndex >= 0 ? entries.slice(0, activeIndex) : entries,
          syncedCount: state.syncedMessageCount,
          turnIds: state.turnIds,
          lastSyncedTurnId: state.lastSyncedTurnId,
          mintTurnId: () => Utility.generateUlid(),
          titleMaxChars: Constants.CONVERSATION_TITLE_MAX_CHARS,
        });

        for (const turn of turns) {
          const recorded = await this.conversationsRepo().recordTurn({
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
            return;
          }
          const current = this.getRuntimeState();
          if (!current) return;
          const turnIds = { ...current.turnIds };
          if (turn.userMessageId !== null) delete turnIds[turn.userMessageId];
          this.patchRuntimeState({
            syncedMessageCount: current.syncedMessageCount + turn.entryCount,
            turnIds,
            lastSyncedTurnId: turn.turnId,
          });
        }
      } while (this.isSyncRequested);
    } finally {
      this.isSyncing = false;
    }
  }

  // DEV_NOTE: One pending auto-close at a time: the previous schedule is cancelled before the new one is set. It runs
  // at the idle deadline, but never sooner than CONVERSATION_CLOSE_RETRY_MS from now, so a deadline already passed
  // (a turn still running, a failed close) can't make it fire in a loop.
  private async armAutoClose(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) return;
    if (state.closeScheduleId) {
      await this.cancelSchedule(state.closeScheduleId);
    }
    const runAt = Math.max(
      state.lastActivityAt + Constants.CONVERSATION_IDLE_CLOSE_MS,
      Date.now() + Constants.CONVERSATION_CLOSE_RETRY_MS,
    );
    const scheduled = await this.schedule(new Date(runAt), "closeIfIdle");
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

  // DEV_NOTE: The trusted system prompt: the company's persona, then its procedures. Knowledge (M2-6) and tools (M3)
  // add their parts later.
  private static buildInstructions(spec: Schemas.ConfigSpec): string {
    const procedures = spec.procedures.map(
      (procedure) =>
        `### ${procedure.name}\nWhen to use: ${procedure.whenToUse}\nSteps:\n${procedure.steps}`,
    );
    return procedures.length > 0
      ? `${spec.persona.instructions}\n\n## Procedures\n\n${procedures.join("\n\n")}`
      : spec.persona.instructions;
  }
}
