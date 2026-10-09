import { Think } from "@cloudflare/think";
import type {
  ChatErrorContext,
  ChatResponseResult,
  TurnConfig,
  TurnContext,
} from "@cloudflare/think";
import type { Connection, ConnectionContext } from "agents";
import type { LanguageModel, UIMessage } from "ai";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import ConversationsRepo from "@/repositories/ConversationsRepo";
import ModelRouterRepo, { ModelUnavailableError } from "@/repositories/ModelRouterRepo";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Shown for any turn failure that isn't the model being unavailable. The reason is logged, never sent.
const TURN_FAILED_MESSAGE = "Something went wrong. Please try again.";
const UNSUPPORTED_FRAME_MESSAGE = "Unsupported message";
const TURN_IN_PROGRESS_MESSAGE = "A reply is still in progress";

// DEV_NOTE: The Conversation DO (M2-2): one per conversation, named by conversations.public_id, built on Think. The
// Think session (DO SQLite) is the transcript's source of truth; messages in Neon is its read model, written after
// every turn with the turn's ULID.
//
// Trust: the widget route authenticates the companion JWT and checks the conversation is the user's own before it
// forwards the upgrade here (ADR 0001), so every socket is verified, and the session arrives in a header only the
// worker sets. Think is then locked down for a public widget: no workspace or bash tools, no tools at all yet, no
// reasoning sent, no identity frame, and inbound frames go through an allowlist (webSocketMessage) before Think sees
// them, because Think would otherwise let a client clear or rewrite the transcript, push tools or set state. A chat
// request is rebuilt to carry only its newest user message, so the DO's session is the only history.
//
// A turn: the frame is admitted only when no other turn is running; the published config is read fresh (a publish
// takes effect at the next turn), the turn's ULID minted, and the model routed through ModelRouterRepo on the company's
// key. If any of that fails the message isn't saved and the widget gets "unavailable". After the reply, its user and
// assistant messages go to the read model, and the auto-close alarm is re-armed: idle for
// CONVERSATION_IDLE_CLOSE_MS → Closed (Answered if any reply completed, else Abandoned).
//
// Never kept here: the host bearer token (M3-8 holds it in a plain field, in memory only).
export class ConversationDO extends Think<Env> {
  static options = { sendIdentityOnConnect: false };

  workspaceBash = false;
  includeMcpTools = false;
  sendReasoning = false;
  // DEV_NOTE: Durable recovery can't resume a turn here: its config and routed model live in memory and are gone
  // after an eviction. An interrupted turn is sealed at once with safe text; the user sends the message again.
  chatRecovery = { maxAttempts: 0, terminalMessage: TURN_FAILED_MESSAGE };

  // DEV_NOTE: The turn being prepared or run: at most one (frames are refused while it is set). In memory only: a
  // turn keeps the DO awake, and an evicted turn is not recovered (chatRecovery).
  private activeTurn: {
    requestId: string;
    turnId: string;
    userMessageId: string;
    userText: string;
    model: LanguageModel | null;
    spec: Schemas.ConfigSpec | null;
  } | null = null;

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

    let state = this.getRuntimeState();
    if (!state) {
      state = {
        session,
        lastActivityAt: Date.now(),
        hasAnswer: false,
        closeScheduleId: null,
        isClosed: false,
      };
      this.configure<Schemas.ConversationRuntimeState>(state);
      await this.armAutoClose();
    } else if (state.session.conversationId !== session.conversationId) {
      connection.close(1008, "Not allowed");
      return;
    }

    if (state.isClosed) {
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

  // DEV_NOTE: Every inbound frame passes here before Agents and Think see it (Agents installs its own handler only
  // when the class has none). Allowed: a chat request (rebuilt, see admitChatRequest), cancel and stream-resume frames.
  // Anything else gets an error frame and goes no further.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const admitted = await this.admitFrame(ws, message);
    if (admitted !== null) {
      await this.lifecycle.webSocketMessage(ws, admitted);
    }
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    await this.finishTurn(result.requestId, result.status, result.message);
  }

  // DEV_NOTE: Its return value is sent to every client as the failed turn's error, so only safe text leaves. A turn
  // that failed after its user message was saved still goes to the read model.
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
        isUnavailable,
      },
    });
    if (ctx?.requestId) {
      this.ctx.waitUntil(this.finishTurn(ctx.requestId, "error", null));
    }
    return isUnavailable ? Schemas.MODEL_UNAVAILABLE_MESSAGE : TURN_FAILED_MESSAGE;
  }

  // DEV_NOTE: Scheduled (schedule()); public because the scheduler calls it by name. Re-arms itself when activity
  // moved the deadline since it was set.
  async closeIfIdle(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) return;

    const idleMs = Date.now() - state.lastActivityAt;
    if (idleMs < Constants.CONVERSATION_IDLE_CLOSE_MS || this.activeTurn) {
      this.patchRuntimeState({ closeScheduleId: null });
      await this.armAutoClose();
      return;
    }

    const closed = await this.conversationsRepo().closeConversation({
      session: state.session,
      outcome: state.hasAnswer
        ? Schemas.ConversationOutcomeIntEnum.Answered
        : Schemas.ConversationOutcomeIntEnum.Abandoned,
    });
    if (!closed.isSuccess && !closed.isNotFound) {
      // DEV_NOTE: The database write failed (logged by the DAL): try again later rather than closing half-way
      this.patchRuntimeState({ closeScheduleId: null });
      await this.armAutoClose();
      return;
    }

    this.patchRuntimeState({ isClosed: true, closeScheduleId: null });
    for (const connection of this.getConnections()) {
      this.send(connection, { type: "closed" });
      connection.close(1000, "Conversation closed");
    }
  }

  // DEV_NOTE: The frame to hand on (rebuilt for a chat request), or null when it was refused
  private async admitFrame(ws: WebSocket, message: string | ArrayBuffer): Promise<string | null> {
    if (typeof message !== "string" || message.length > Constants.WIDGET_FRAME_MAX_BYTES) {
      this.reply(ws, { type: "error", message: UNSUPPORTED_FRAME_MESSAGE });
      return null;
    }
    const json = Utility.parseJson(message);
    const envelope = Schemas.ZWidgetFrameEnvelope.safeParse(json);
    if (!envelope.success) {
      this.reply(ws, { type: "error", message: UNSUPPORTED_FRAME_MESSAGE });
      return null;
    }

    if (envelope.data.type === Schemas.WidgetChatFrameTypeEnum.ChatRequest) {
      return await this.admitChatRequest(ws, json);
    }
    if (Schemas.ZWidgetPassThroughFrame.safeParse(json).success) {
      return message;
    }

    AppLogger.warn({
      category: Schemas.LogCategory.Conversation,
      action: Schemas.LogAction.FilterWidgetFrame,
      message: "Frame type not allowed",
      metadata: { conversationPublicId: this.name, frameType: envelope.data.type.slice(0, 64) },
    });
    this.reply(ws, { type: "error", message: UNSUPPORTED_FRAME_MESSAGE });
    return null;
  }

  // DEV_NOTE: A new user turn. Rebuilt to carry only the newest message, as plain text with the client's id (which
  // must be new: Think would otherwise overwrite the stored message with that id), and nothing else from the body
  // (no client tools, no custom fields). The config and the model are ready before Think saves the message.
  private async admitChatRequest(ws: WebSocket, json: unknown): Promise<string | null> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) {
      this.reply(ws, { type: "closed" });
      ws.close(1000, "Conversation closed");
      return null;
    }
    if (this.activeTurn) {
      this.reply(ws, { type: "error", message: TURN_IN_PROGRESS_MESSAGE });
      return null;
    }

    const frame = Schemas.ZWidgetChatRequestFrame.safeParse(json);
    const body = frame.success
      ? Schemas.ZWidgetChatRequestBody.safeParse(Utility.parseJson(frame.data.init.body))
      : null;
    const newest = body?.success
      ? Schemas.ZWidgetUserMessage.safeParse(body.data.messages[body.data.messages.length - 1])
      : null;
    const text = newest?.success
      ? newest.data.parts
          .map((part) => part.text)
          .join("\n")
          .trim()
      : "";
    if (
      !frame.success ||
      !newest?.success ||
      text.length === 0 ||
      text.length > Schemas.WIDGET_MESSAGE_MAX_CHARS ||
      this.messages.some((message) => message.id === newest.data.id)
    ) {
      this.reply(ws, { type: "error", message: UNSUPPORTED_FRAME_MESSAGE });
      return null;
    }

    const turn = {
      requestId: frame.data.id,
      turnId: Utility.generateUlid(),
      userMessageId: newest.data.id,
      userText: text,
      model: null,
      spec: null,
    };
    this.activeTurn = turn;

    const prepared = await this.prepareTurn(state.session, turn.turnId);
    if (!prepared) {
      this.activeTurn = null;
      this.reply(ws, { type: "unavailable", message: Schemas.MODEL_UNAVAILABLE_MESSAGE });
      return null;
    }
    this.activeTurn = { ...turn, model: prepared.model, spec: prepared.spec };

    return JSON.stringify({
      type: Schemas.WidgetChatFrameTypeEnum.ChatRequest,
      id: frame.data.id,
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [{ id: newest.data.id, role: "user", parts: [{ type: "text", text }] }],
        }),
      },
    });
  }

  // DEV_NOTE: The published config (read fresh: a publish takes effect here) and the routed model. null when the
  // chatbot can't answer: nothing published, or no usable model (the router logs it and opens the system issue).
  private async prepareTurn(
    session: Schemas.ConversationSession,
    turnId: string,
  ): Promise<{ spec: Schemas.ConfigSpec; model: LanguageModel } | null> {
    const config = await this.conversationsRepo().loadTurnConfig({ session });
    if (!config.isSuccess || !config.spec) return null;

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
    if (!routed.isSuccess) return null;
    return { spec: config.spec, model: routed.model };
  }

  // DEV_NOTE: Ends the active turn once (onChatResponse, or onChatError for a turn that failed before a response):
  // its user message and, if there is one, the reply go to the read model with the turn's ULID; then the activity
  // bookkeeping and the auto-close alarm.
  private async finishTurn(
    requestId: string,
    status: ChatResponseResult["status"],
    reply: UIMessage | null,
  ): Promise<void> {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    if (!turn || turn.requestId !== requestId || !state) return;

    const messages: Schemas.TurnMessage[] = [];
    const userMessage = this.messages.find((message) => message.id === turn.userMessageId);
    if (userMessage) {
      messages.push({
        sessionMessageId: userMessage.id,
        role: Schemas.MessageRoleIntEnum.User,
        content: { text: ConversationDO.textOf(userMessage) },
      });
    }
    const replyText = reply ? ConversationDO.textOf(reply) : "";
    if (reply && replyText.length > 0) {
      messages.push({
        sessionMessageId: reply.id,
        role: Schemas.MessageRoleIntEnum.Assistant,
        content: { text: replyText },
      });
    }

    // DEV_NOTE: The activity is stored before the turn is released and before any await, so an auto-close that
    // fires meanwhile already sees this turn (and its answer)
    this.patchRuntimeState({
      lastActivityAt: Date.now(),
      hasAnswer: state.hasAnswer || (status === "completed" && replyText.length > 0),
    });
    this.activeTurn = null;

    if (messages.length > 0) {
      const recorded = await this.conversationsRepo().recordTurn({
        session: state.session,
        turnId: turn.turnId,
        messages,
        title: turn.userText.slice(0, Constants.CONVERSATION_TITLE_MAX_CHARS),
      });
      if (!recorded.isSuccess) {
        AppLogger.error({
          category: Schemas.LogCategory.Conversation,
          action: Schemas.LogAction.RecordTurn,
          message: recorded.message ?? "Turn not recorded in the read model",
          metadata: { conversationPublicId: this.name, turnId: turn.turnId },
        });
      }
    }

    await this.armAutoClose();
  }

  // DEV_NOTE: One pending auto-close at a time: the previous schedule is cancelled before the new one is set
  private async armAutoClose(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) return;
    if (state.closeScheduleId) {
      await this.cancelSchedule(state.closeScheduleId);
    }
    const scheduled = await this.schedule(
      new Date(state.lastActivityAt + Constants.CONVERSATION_IDLE_CLOSE_MS),
      "closeIfIdle",
    );
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

  // DEV_NOTE: The trusted system prompt: the company's persona, then its procedures. Knowledge (M2-6) and tools
  // (M3) add their parts later.
  private static buildInstructions(spec: Schemas.ConfigSpec): string {
    const procedures = spec.procedures.map(
      (procedure) =>
        `### ${procedure.name}\nWhen to use: ${procedure.whenToUse}\nSteps:\n${procedure.steps}`,
    );
    return procedures.length > 0
      ? `${spec.persona.instructions}\n\n## Procedures\n\n${procedures.join("\n\n")}`
      : spec.persona.instructions;
  }

  private static textOf(message: UIMessage): string {
    return message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
  }
}
