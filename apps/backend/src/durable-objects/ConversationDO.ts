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
import HostTokenAsk from "@/hostToken/HostTokenAsk";
import Constants from "@/config/Constants";
import { BudgetDO } from "@/durable-objects/BudgetDO";
import EvalAttemptProvider from "@/providers/evalAttempt";
import HostToolCallProvider from "@/providers/hostToolCall";
import HostToolsProvider from "@/providers/hostTools";
import AppLogger from "@/providers/logger";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import SearchHelpDocsProvider from "@/providers/searchHelpDocs";
import TranscriptProvider from "@/providers/transcript";
import WidgetFrameProvider from "@/providers/widgetFrames";
import ChangeRequestsProvider, { UNDO_TEXT } from "@/providers/changeRequests";
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
const CLOSED_MESSAGE = "This conversation has ended";
// DEV_NOTE: An edit's refusals (M3-5). Each says what did not happen: the proposal still waits as it was.
const EDIT_LOCKED_MESSAGE = "Some of these fields can't be changed here. Nothing changed.";
const EDIT_INVALID_MESSAGE = "Some values don't fit. Nothing changed.";
const EDIT_NO_CHANGE_MESSAGE = "That's what the record already shows. Nothing changed.";
const EDIT_RECHECK_FAILED_MESSAGE = "The record couldn't be checked again. Nothing changed.";
const EDIT_UNAVAILABLE_MESSAGE = "This change can't be edited right now. Nothing changed.";

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
  committed:
    "The change was made in the app; it is still being checked. Tell the user it is saved and being checked.",
  verified: "The change was made in the app and checked: the record shows it.",
  undoing:
    "The app didn't save the change as expected, so it is being undone. Tell the user plainly; don't try it again now.",
  undone:
    "The app didn't save the change as expected, so it was undone: the record is as it was. Tell the user nothing changed.",
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

// DEV_NOTE: A decision that finds its change request already past the commit's start: the entry's stage to resume from
const DECIDED_OPEN_STAGE: Partial<
  Record<Schemas.ChangeRequestStatusIntEnum, Schemas.ConversationChangeRequestStageEnum>
> = {
  [Schemas.ChangeRequestStatusIntEnum.Committing]:
    Schemas.ConversationChangeRequestStageEnum.Committing,
  [Schemas.ChangeRequestStatusIntEnum.Committed]:
    Schemas.ConversationChangeRequestStageEnum.Verifying,
  [Schemas.ChangeRequestStatusIntEnum.Mismatch]: Schemas.ConversationChangeRequestStageEnum.Undoing,
};

// DEV_NOTE: How a landed commit's follow-up ended: what execute answers, and how its undo's host call ended (null when no
// undo was sent)
interface FollowUpRun {
  output: Schemas.HostToolOutput;
  undoOutcome: Schemas.HostCallOutcomeEnum | null;
}

// DEV_NOTE: A change request the database decided, with the status its pause is resolved by
interface DecidedChangeRequest {
  toolCallId: string;
  entry: Schemas.ConversationChangeRequestEntry;
  status: Schemas.ChangeRequestStatusIntEnum;
}

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
// The widget's change_request_decision and change_request_batch_decision frames approve or reject (an approval needs
// the host token: token_needed otherwise). Answers or the expiry claim the conversation before their first await
// (isDeciding, so nothing else starts meanwhile), are decided in the database first (which enforces the deadline), and
// the DO then follows each row's status, whoever set it. The approved ones are committed (Approved → Committing →
// Committed / Failed / NeedsHuman), then Think's approveExecution / rejectExecution resolves every pause from its own
// storage, back to back, so the pauses survive an eviction and the chat continues once; the DO prepares that
// continuation like a turn (config, tools, model, budget), and each action's execute answers its commit's outcome.
// The change_request_edits frame (M3-5) changes a proposal's values: each edit is re-checked like a new proposal
// (editable fields only, input_schema, a fresh read-before, the diff rebuilt) and the proposal waits again. A commit an
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
// Undo (M3-7): a Verified change request can be undone by the user until its undo_until (CHANGE_REQUEST_UNDO_WINDOW_MS
// after it was verified). The DO keeps those in undoWindows (re-sent on connect, so the card keeps its Undo button)
// and the change_request_undos frame asks for them: each is re-checked like a commit (ActionEngineRepo.startUndo),
// then undone like a Mismatch (inverse_op as the user, then read again → Undone, back to Verified when nothing may
// have reached the host, else NeedsHuman). No model call: the next turn's system prompt says what the user undid.
//
// Auto-close: idle for CONVERSATION_IDLE_CLOSE_MS with no open change request and no undo window still open → Closed
// (Answered if any reply completed, else Abandoned). A close that can't act yet retries no sooner than
// CONVERSATION_CLOSE_RETRY_MS.
//
// The host bearer token lives in a plain field, in memory only: never in Think state, configure, SQLite or a log
// (pattern rule 3.11). An eviction drops it; the widget sends it again.
//
// Token refresh (M3-8): a host call that finds no token, or whose token the host refused (when nothing may have
// landed, or the call is a resume, so a second try can't write twice), asks every open socket for a fresh one
// (HostTokenAsk: token_needed, reason refresh, which the widget answers silently) and waits up to HOST_TOKEN_WAIT_MS,
// then tries once more. A refused token is dropped from memory. A read in a turn that still has none tells the model
// to ask the user to sign in. A commit, read-after or undo that still has none keeps its entry (tokenNeededSince, and
// isUnsent when its first send reached nothing, so its resume is sent fresh) and resumes on the next host_token; one
// still waiting HOST_TOKEN_GRACE_MS after it first needed the token (no widget came back) is handed to a person
// (NeedsHuman token_needed). A wake with entries to resume and no token asks the open sockets too.
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
  // DEV_NOTE: The ask for a fresh host token (M3-8): token_needed (reason refresh) to every open socket, shared by every
  // step that needs one meanwhile, not repeated for HOST_TOKEN_WAIT_MS after one timed out (HostTokenAsk)
  private readonly tokenAsk = new HostTokenAsk({
    ask: () => this.askSocketsForToken(),
    waitMs: Constants.HOST_TOKEN_WAIT_MS,
  });
  // DEV_NOTE: A write call that ended in its approval hook without a change to make (refused, nothing to change): the
  // output its execute returns right after, by Think tool call id
  private settledCalls = new Map<string, Schemas.HostToolOutput>();
  // DEV_NOTE: An approved change committed before its pause was resolved (an answer commits first, then resolves the
  // batch's pauses together): the outcome its execute returns, by Think tool call id
  private approvedOutputs = new Map<string, Schemas.HostToolOutput>();
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
    return turn?.spec
      ? ConversationDO.buildInstructions(turn.spec, turn.tools.length > 0, turn.userUndoNotes)
      : "";
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
  // never here on a wake): the widget's host_token frame resumes it, and the retry or auto-close check asks for one
  // (M3-8).
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

    // DEV_NOTE: An eval attempt's conversation (M5-2) never takes a socket: it runs the run's config with writes
    // approved, for the harness only (ConversationsRepo.startOrResume refuses it too)
    const existing = this.getRuntimeState();
    if (
      session.eval !== null ||
      (existing &&
        (existing.session.conversationId !== session.conversationId ||
          existing.session.eval !== null))
    ) {
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
      this.configure(ConversationDO.initialRuntimeState(session, roles));
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

    // DEV_NOTE: The change requests still open, and the Verified ones the user can still undo, so a reconnecting widget
    // can show them (a database read only when there are some)
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
      // DEV_NOTE: A step waiting for the token tries again; a commit cut short (an eviction, a failed write, no token)
      // can run again now that the DO can act as the user
      this.tokenAsk.arrived();
      this.ctx.waitUntil(this.resumeCommits());
      return;
    }
    if (admission.kind === "decisions") {
      await this.decideChangeRequests(ws, admission.decisions);
      return;
    }
    if (admission.kind === "edits") {
      await this.editChangeRequests(ws, admission.edits);
      return;
    }
    if (admission.kind === "undos") {
      await this.undoChangeRequests(ws, admission.changeRequestPublicIds);
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
  // lifted and the close retried later. A conversation with an open change request waits (its expiry ends it first),
  // and so does one with a Verified change the user can still undo (until its undo window ends, M3-7).
  async closeIfIdle(): Promise<void> {
    this.dropEndedUndoWindows();
    const state = this.getRuntimeState();
    if (!state || state.isClosed || this.isClosing) return;

    const idleMs = Date.now() - state.lastActivityAt;
    const hasOpenChange = Object.keys(state.changeRequests).length > 0;
    const hasUndoWindow = Object.keys(state.undoWindows).length > 0;
    if (
      idleMs < Constants.CONVERSATION_IDLE_CLOSE_MS ||
      this.isBusy() ||
      hasOpenChange ||
      hasUndoWindow
    ) {
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
      await this.resolvePending(payload.toolCallId, entry);
    } finally {
      this.isDeciding = false;
    }
  }

  // DEV_NOTE: Scheduled after a commit that couldn't start or finish its database write, and at the end of a wait for
  // the host token (public: the scheduler calls it by name). A step whose grace for the token has passed is handed to a
  // person first.
  async retryCommits(): Promise<void> {
    await this.handOverTokenWaits();
    await this.resumeCommits();
  }

  // DEV_NOTE: An eval attempt (M5-2), called by EvalHarnessRepo over DO RPC on a conversation it just started: the
  // session (with its eval context) is stored like a first connect's, with no roles, and the harness's host token held
  // in memory for the attempt only. The case's messages are saved and the last one answered in one turn
  // (saveMessages), prepared like a widget turn but on the run's config (loadTurnTools on the staging connection, the
  // run's id on every model call). Writes are approved as proposed (proposeWrite) and committed and verified in the
  // turn. No socket: a step that needs a fresh host token finds no one to ask and fails at once. Answers the turn's
  // status, the last reply and every tool call of the attempt (from the transcript: the tool parts after the first
  // saved message), as JSON text (Schemas.ZEvalAttemptRunResponse). One attempt per conversation.
  async runEvalAttempt(params: {
    session: Schemas.ConversationSession;
    hostToken: string;
    messages: Schemas.EvalCaseMessage[];
  }): Promise<string> {
    return JSON.stringify(await this.runEvalAttemptTurn(params));
  }

  private async runEvalAttemptTurn(params: {
    session: Schemas.ConversationSession;
    hostToken: string;
    messages: Schemas.EvalCaseMessage[];
  }): Promise<Schemas.EvalAttemptRunResponse> {
    const fail = (
      failure: Schemas.EvalAttemptFailureEnum,
      message: string,
    ): Schemas.EvalAttemptRunResponse => ({ isSuccess: false, message, failure });
    await this.__unsafe_ensureInitialized();
    const parsed = Schemas.ZConversationSession.safeParse(params.session);
    const messages = Schemas.ZEvalCaseMessages.safeParse(params.messages);
    if (!parsed.success || !parsed.data.eval || parsed.data.conversationPublicId !== this.name) {
      return fail(
        Schemas.EvalAttemptFailureEnum.ServerError,
        "Not an eval session of this conversation",
      );
    }
    if (!messages.success) {
      return fail(Schemas.EvalAttemptFailureEnum.ServerError, "The case's messages don't parse");
    }
    if (this.getRuntimeState() !== null || this.messages.length > 0 || this.isBusy()) {
      return fail(Schemas.EvalAttemptFailureEnum.ServerError, "This conversation already ran");
    }
    const session = parsed.data;
    this.configure(ConversationDO.initialRuntimeState(session, { roles: [], expiresAt: 0 }));
    await this.armAutoClose();

    const saved = EvalAttemptProvider.toUIMessages(messages.data);
    const firstId = saved[0]?.id;
    const userMessageId = saved.at(-1)?.id;
    if (!firstId || !userMessageId) {
      return fail(Schemas.EvalAttemptFailureEnum.ServerError, "The case has no message");
    }
    const turnId = Utility.generateUlid();
    const requestId = `eval:${turnId}`;
    const turn = { requestId, turnId, userMessageId, isEval: true };
    this.activeTurn = ConversationDO.newTurn(turn);
    this.patchRuntimeState({ turnIds: { [userMessageId]: turnId } });

    const prepared = await this.prepareTurn(session, turnId);
    if (!prepared.isSuccess) {
      this.activeTurn = null;
      this.patchRuntimeState({ turnIds: {} });
      return prepared.refusal
        ? fail(Schemas.EvalAttemptFailureEnum.BudgetRefused, "A budget refused the turn")
        : fail(Schemas.EvalAttemptFailureEnum.ChatbotUnavailable, "The chatbot can't answer");
    }
    this.activeTurn = this.preparedTurn(ConversationDO.newTurn(turn), prepared);

    this.hostToken = params.hostToken;
    let status: Schemas.EvalTurnStatusEnum;
    try {
      const result = await this.saveMessages(saved);
      status = EvalAttemptProvider.turnStatus(result.status);
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.RunEvalAttempt,
        message: "Eval turn failed",
        error,
        metadata: { conversationPublicId: this.name },
      });
      status = Schemas.EvalTurnStatusEnum.Error;
    } finally {
      // DEV_NOTE: A turn Think ended without onChatResponse is ended here; one that did end is already released
      await this.finishTurn(requestId, "error", null, true);
      this.hostToken = null;
    }

    return {
      isSuccess: true,
      message: "Eval attempt ran",
      turnStatus: status,
      ...EvalAttemptProvider.summarize(this.messages, firstId),
    };
  }

  // DEV_NOTE: A conversation's state at its first connect (or an eval attempt's start): nothing synced, no turn, no
  // change request, the connect's roles
  private static initialRuntimeState(
    session: Schemas.ConversationSession,
    roles: Schemas.ConversationRolesGrant,
  ): Schemas.ConversationRuntimeState {
    return {
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
      undoWindows: {},
      userUndos: {},
    };
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

  // DEV_NOTE: A turn prepared for Think: its config, tools, model and budget, whether the transcript already holds
  // untrusted content (then every write in it needs approval), and the changes the user undid in this conversation
  // (M3-7: every turn, since the transcript still says they were made)
  private preparedTurn(
    turn: Schemas.ActiveTurn<LanguageModel, TurnBudget>,
    prepared: Extract<Schemas.PreparedTurn<LanguageModel, TurnBudget>, { isSuccess: true }>,
  ): Schemas.ActiveTurn<LanguageModel, TurnBudget> {
    const userUndoNotes = Object.values(this.getRuntimeState()?.userUndos ?? {});
    return {
      ...turn,
      userUndoNotes,
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
    isEval?: boolean;
  }): Schemas.ActiveTurn<LanguageModel, TurnBudget> {
    return {
      requestId: params.requestId,
      startedAt: Date.now(),
      turnId: params.turnId,
      userMessageId: params.userMessageId,
      isContinuation: params.userMessageId === null,
      isEval: params.isEval ?? false,
      model: null,
      spec: null,
      caps: null,
      tools: [],
      citationCount: 0,
      searchExcerpts: {},
      isUntrusted: false,
      toolCallKeys: [],
      isLoopStopped: false,
      userUndoNotes: [],
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
      // DEV_NOTE: An eval attempt's calls are its run's (M5-2): eval_runs.cost_usd sums them
      evalRunId: session.eval?.evalRunId ?? null,
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
  // execution ids of the proposals it parked and re-arms the auto-close. A continuation (and an eval attempt's turn,
  // run by saveMessages) has Think's own request id, so the first turn end Think reports while one is active is it; the
  // DO's own fallback end of a request (isFallback) ends only that request's turn, never a continuation an answer
  // started meanwhile.
  private async finishTurn(
    requestId: string,
    status: ChatResponseResult["status"],
    reply: ChatResponseResult["message"] | null,
    isFallback = false,
  ): Promise<void> {
    const turn = this.activeTurn;
    const state = this.getRuntimeState();
    if (!turn || !state) return;
    if (turn.requestId !== requestId && (isFallback || !(turn.isContinuation || turn.isEval))) {
      return;
    }

    const replyText = reply ? (TranscriptProvider.toEntries([reply])[0]?.text ?? "") : "";
    this.patchRuntimeState({
      lastActivityAt: Date.now(),
      hasAnswer: state.hasAnswer || (status === "completed" && replyText.length > 0),
    });
    this.activeTurn = null;
    // DEV_NOTE: An approval hook's outcome whose execute never ran (the turn ended in between) is dropped with the turn,
    // and so is a commit's outcome Think never asked for
    this.settledCalls.clear();
    this.approvedOutputs.clear();

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
    // DEV_NOTE: Not before the last undo window ends (M3-7): the close waits for it anyway
    const runAt = Math.max(
      state.lastActivityAt + Constants.CONVERSATION_IDLE_CLOSE_MS,
      Date.now() + Constants.CONVERSATION_CLOSE_RETRY_MS,
      ...Object.values(state.undoWindows).map((window) => window.undoUntil),
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

  // DEV_NOTE: Every change request view the DO sends to every socket goes through here, so the undo windows (M3-7)
  // follow the views: a Verified one the user can undo is kept (by its tool call id), any other drops its window
  private broadcastChangeRequest(changeRequest: Schemas.WidgetChangeRequest | undefined): void {
    if (!changeRequest) return;
    const view = this.withToolCallId(changeRequest);
    this.trackUndoWindow(view);
    for (const connection of this.getConnections()) {
      this.send(connection, { type: "change_request", changeRequest: view });
    }
  }

  // DEV_NOTE: The view with the Think tool call id of its open entry or undo window (the widget places the card by
  // it); null once neither holds it (the call's output names the change request then)
  private withToolCallId(changeRequest: Schemas.WidgetChangeRequest): Schemas.WidgetChangeRequest {
    const state = this.getRuntimeState();
    const found =
      Object.entries(state?.changeRequests ?? {}).find(
        ([, entry]) => entry.publicId === changeRequest.publicId,
      ) ??
      Object.entries(state?.undoWindows ?? {}).find(
        ([, window]) => window.publicId === changeRequest.publicId,
      );
    return { ...changeRequest, toolCallId: found?.[0] ?? null };
  }

  // DEV_NOTE: What a view changes in the undo bookkeeping (M3-7), no await between read and write: its undo window
  // (ChangeRequestsProvider.nextUndoWindows), and, once the user's undo of it ended Undone (by whichever path: the
  // undo itself or its resume), its summary for every later turn's system prompt
  private trackUndoWindow(view: Schemas.WidgetChangeRequest): void {
    const state = this.getRuntimeState();
    if (!state) return;
    const isUserUndone = view.undoneBy === Schemas.ChangeRequestUndoneByEnum.User;
    this.patchRuntimeState({
      undoWindows: ChangeRequestsProvider.nextUndoWindows(state.undoWindows, view),
      ...(isUserUndone && !state.userUndos[view.publicId]
        ? { userUndos: { ...state.userUndos, [view.publicId]: view.summary } }
        : {}),
    });
  }

  // DEV_NOTE: Undo windows past their end go (the database refuses an undo after undo_until anyway)
  private dropEndedUndoWindows(): void {
    const state = this.getRuntimeState();
    if (!state) return;
    const undoWindows = ChangeRequestsProvider.openUndoWindows(state.undoWindows, Date.now());
    if (Object.keys(undoWindows).length === Object.keys(state.undoWindows).length) return;
    this.patchRuntimeState({ undoWindows });
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
    const { response: called } = await this.withFreshToken(
      async () =>
        await HostToolCallProvider.read({
          tool: hostTool,
          args,
          getHostToken: () => this.hostToken,
          signal,
        }),
      { isResume: false, signal },
    );
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
        const { response: read } = await this.withFreshToken(
          async () =>
            await HostToolCallProvider.readBefore({
              tool: hostTool,
              args,
              getHostToken: () => this.hostToken,
            }),
          { isResume: false },
        );
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

      // DEV_NOTE: An eval attempt has no user to answer (M5-2): every write the rules let through is approved as
      // proposed and committed in the turn, then verified like any other; a Blocked one stays blocked
      const isApprovalRequired =
        approval === Schemas.ApprovalRuleApprovalEnum.Required && state.session.eval === null;
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
        tokenNeededSince: null,
        isUnsent: false,
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

  // DEV_NOTE: A write action's execute: the hook's own outcome when the call settled there, the outcome of the commit
  // an answer already ran, else the commit of its change request (needing no approval, or resumed)
  private async commitChange(toolCallId: string): Promise<Schemas.HostToolOutput> {
    const settled = this.settledCalls.get(toolCallId);
    if (settled) {
      this.settledCalls.delete(toolCallId);
      return settled;
    }
    const committed = this.approvedOutputs.get(toolCallId);
    if (committed) {
      this.approvedOutputs.delete(toolCallId);
      return committed;
    }
    const entry = this.getRuntimeState()?.changeRequests[toolCallId];
    if (!entry || entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending) {
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.notWaiting);
    }
    return await this.runCommit(toolCallId, entry);
  }

  // DEV_NOTE: The commit: Committing (its key stored first), the host write as the user, and the end status; a commit
  // that landed goes on to its read-after and, on a mismatch, its auto-undo (runFollowUp) before execute answers. Anything
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
      // DEV_NOTE: A commit that landed but whose read-after or undo didn't finish takes up from there (M3-6)
      if (
        entry.stage === Schemas.ConversationChangeRequestStageEnum.Verifying ||
        entry.stage === Schemas.ConversationChangeRequestStageEnum.Undoing ||
        entry.stage === Schemas.ConversationChangeRequestStageEnum.UserUndoing
      ) {
        return (await this.runFollowUp(toolCallId, entry, null)).output;
      }
      this.patchChangeRequest(toolCallId, {
        stage: Schemas.ConversationChangeRequestStageEnum.Committing,
      });
      const repo = this.actionEngineRepo();
      const started = await repo.startCommit({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        attemptId: Utility.generateUlid(),
        isUnsent: entry.isUnsent,
      });
      this.relayEvents(started.outboxIds);
      this.broadcastChangeRequest(started.changeRequest);
      if (!started.isSuccess || !started.plan) {
        return await this.endUnstartedCommit(toolCallId, entry, started);
      }

      const plan = started.plan;
      // DEV_NOTE: From here the write may reach the host: a resume after an eviction mid-send must not send it fresh
      this.patchChangeRequest(toolCallId, { isUnsent: false });
      const { response: committed, isWaiting } = await this.withFreshToken(
        async () => await HostToolCallProvider.commit({ plan, getHostToken: () => this.hostToken }),
        { isResume: plan.isResume },
      );
      if (
        committed.outcome !== Schemas.HostCallOutcomeEnum.Succeeded &&
        committed.outcome !== Schemas.HostCallOutcomeEnum.AlreadyApplied
      ) {
        this.logHostCall(plan.tool, committed, "Commit didn't succeed");
      }
      // DEV_NOTE: No token (or a refused one and no fresh one came): the commit stays Committing until the token comes
      // back, or goes to a person after HOST_TOKEN_GRACE_MS (M3-8). A fresh send that reached nothing resumes fresh.
      if (isWaiting) {
        await this.waitForToken(toolCallId, !plan.isResume);
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Error,
          TOOL_TEXT.commitUnconfirmed,
          entry.publicId,
        );
      }
      this.patchChangeRequest(toolCallId, { tokenNeededSince: null });

      const finished = await repo.finishCommit({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        hostCall: committed,
        plan,
      });
      this.relayEvents(finished.outboxIds);
      this.broadcastChangeRequest(finished.changeRequest);
      if (finished.followUp) {
        return (await this.runFollowUp(toolCallId, entry, finished.followUp)).output;
      }
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
    const status = started.changeRequest?.changeRequestStatus;
    // DEV_NOTE: The commit already landed (this entry missed its end): take up its read-after or undo instead
    if (
      status === Schemas.ChangeRequestStatusIntEnum.Committed ||
      status === Schemas.ChangeRequestStatusIntEnum.Mismatch
    ) {
      return (await this.runFollowUp(toolCallId, entry, null)).output;
    }
    this.patchChangeRequest(toolCallId, null);
    if (status === undefined) {
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.notWaiting);
    }
    return ConversationDO.commitOutput(entry.publicId, status);
  }

  // DEV_NOTE: A landed commit's next steps (M3-6), under the caller's commitsInFlight claim: the read-after (readback_op
  // as the user) → Verified / NeedsHuman, or Mismatch → the auto-undo (inverse_op as the user, then read again) →
  // Undone / NeedsHuman. plan null = read it from the row (a resume). A step that couldn't be sent for want of the host
  // token keeps the entry (verifying / undoing) for the next host_token; a database step that failed keeps it for a
  // retry (ACTION_COMMIT_RETRY_MS). execute answers the outcome reached.
  private async runFollowUp(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    plan: Schemas.FollowUpPlan | null,
  ): Promise<FollowUpRun> {
    const state = this.getRuntimeState();
    if (!state) {
      return {
        output: HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.unavailable),
        undoOutcome: null,
      };
    }
    const repo = this.actionEngineRepo();
    let next = plan;
    if (!next) {
      const started = await repo.startFollowUp({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        attemptId: Utility.generateUlid(),
        isUnsent: this.getRuntimeState()?.changeRequests[toolCallId]?.isUnsent ?? entry.isUnsent,
      });
      this.relayEvents(started.outboxIds);
      this.broadcastChangeRequest(started.changeRequest);
      if (!started.followUp) {
        return { output: await this.endFollowUp(toolCallId, entry, started), undoOutcome: null };
      }
      next = started.followUp;
    }
    const getHostToken = () => this.hostToken;

    if (next.followUp === Schemas.ChangeRequestFollowUpEnum.Verify) {
      const verifyPlan = next;
      this.patchChangeRequest(toolCallId, {
        stage: Schemas.ConversationChangeRequestStageEnum.Verifying,
      });
      const { response: read, isWaiting } = await this.withFreshToken(
        async () => await HostToolCallProvider.readAfter({ plan: verifyPlan, getHostToken }),
        { isResume: false },
      );
      // DEV_NOTE: Read back once the token comes back, never judged on a read the host refused for want of it (M3-8)
      if (isWaiting) {
        await this.waitForToken(toolCallId, false);
        return {
          output: HostToolsProvider.output(
            Schemas.HostToolStatusEnum.Committed,
            TOOL_TEXT.committed,
            entry.publicId,
          ),
          undoOutcome: null,
        };
      }
      this.patchChangeRequest(toolCallId, { tokenNeededSince: null });
      if (read.outcome !== Schemas.HostCallOutcomeEnum.Succeeded) {
        this.logHostCall(next.tool, read, "Read-after didn't succeed");
      }
      const verified = await repo.finishVerify({
        session: state.session,
        changeRequestPublicId: entry.publicId,
        plan: next,
        readback: read,
      });
      this.relayEvents(verified.outboxIds);
      this.broadcastChangeRequest(verified.changeRequest);
      if (!verified.followUp) {
        return { output: await this.endFollowUp(toolCallId, entry, verified), undoOutcome: null };
      }
      next = verified.followUp;
    }

    // DEV_NOTE: The user's own undo (M3-7) keeps its stage (and its give-up deadline)
    const current = this.getRuntimeState()?.changeRequests[toolCallId];
    if (current?.stage !== Schemas.ConversationChangeRequestStageEnum.UserUndoing) {
      this.patchChangeRequest(toolCallId, {
        stage: Schemas.ConversationChangeRequestStageEnum.Undoing,
      });
    }
    const undoPlan = next;
    // DEV_NOTE: From here the undo may reach the host: a resume after an eviction mid-send must not send it fresh
    this.patchChangeRequest(toolCallId, { isUnsent: false });
    const { response: undo, isWaiting } = await this.withFreshToken(
      async () => await HostToolCallProvider.undo({ plan: undoPlan, getHostToken }),
      { isResume: undoPlan.isResume },
    );
    // DEV_NOTE: No token (or a refused one and no fresh one came), and nothing landed or it was a resume: the undo
    // waits for the token, or goes to a person after HOST_TOKEN_GRACE_MS (M3-8)
    if (isWaiting) {
      await this.waitForToken(toolCallId, !undoPlan.isResume);
      return {
        output: HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Error,
          TOOL_TEXT.undoing,
          entry.publicId,
        ),
        undoOutcome: undo.outcome,
      };
    }
    this.patchChangeRequest(toolCallId, { tokenNeededSince: null });
    const isUndoSent =
      undo.outcome === Schemas.HostCallOutcomeEnum.Succeeded ||
      undo.outcome === Schemas.HostCallOutcomeEnum.AlreadyApplied;
    if (!isUndoSent) this.logHostCall(next.tool, undo, "Undo didn't succeed");
    let reread: Schemas.HostCallResponse | null = null;
    if (isUndoSent) {
      const reading = await this.withFreshToken(
        async () => await HostToolCallProvider.readAfter({ plan: undoPlan, getHostToken }),
        { isResume: false },
      );
      // DEV_NOTE: Like the read-after: never judged on a read the host refused for want of the token. The undo landed,
      // so the entry waits as a resume (its row holds the undo key): it is resent as one (Native: same key; Emulated
      // checks first and finds it applied), then read again.
      if (reading.isWaiting) {
        await this.waitForToken(toolCallId, false);
        return {
          output: HostToolsProvider.output(
            Schemas.HostToolStatusEnum.Error,
            TOOL_TEXT.undoing,
            entry.publicId,
          ),
          undoOutcome: undo.outcome,
        };
      }
      reread = reading.response;
    }
    const undone = await repo.finishUndo({
      session: state.session,
      changeRequestPublicId: entry.publicId,
      plan: undoPlan,
      undo,
      readback: reread,
    });
    this.relayEvents(undone.outboxIds);
    this.broadcastChangeRequest(undone.changeRequest);
    return { output: await this.endFollowUp(toolCallId, entry, undone), undoOutcome: undo.outcome };
  }

  // DEV_NOTE: A follow-up step's end: a settled change request ends its entry with its outcome; one still open (a
  // database step that failed, a refusal that left it Committed / Mismatch) keeps it for a retry, and the model hears
  // it isn't confirmed yet, never a guess
  private async endFollowUp(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    response: Schemas.ChangeRequestStepResponse,
  ): Promise<Schemas.HostToolOutput> {
    const status = response.changeRequest?.changeRequestStatus;
    const isOpen =
      status === undefined ||
      status === Schemas.ChangeRequestStatusIntEnum.Committed ||
      status === Schemas.ChangeRequestStatusIntEnum.Mismatch;
    if (response.failure === Schemas.ChangeRequestFailureEnum.NotFound) {
      this.patchChangeRequest(toolCallId, null);
      return HostToolsProvider.output(Schemas.HostToolStatusEnum.Error, TOOL_TEXT.notWaiting);
    }
    if (response.failure === Schemas.ChangeRequestFailureEnum.ServerError || isOpen) {
      AppLogger.error({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.VerifyChangeRequest,
        message: response.message ?? "Follow-up end not recorded; resumed later",
        metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
      });
      await this.scheduleCommitRetry();
      return HostToolsProvider.output(
        Schemas.HostToolStatusEnum.NeedsReview,
        TOOL_TEXT.commitUnconfirmed,
        entry.publicId,
      );
    }
    this.patchChangeRequest(toolCallId, null);
    return ConversationDO.commitOutput(entry.publicId, status);
  }

  private async scheduleCommitRetry(
    runAt: number = Date.now() + Constants.ACTION_COMMIT_RETRY_MS,
  ): Promise<void> {
    try {
      await this.schedule(new Date(runAt), "retryCommits");
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
      case Schemas.ChangeRequestStatusIntEnum.Verified:
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Verified,
          TOOL_TEXT.verified,
          changeRequestPublicId,
        );
      case Schemas.ChangeRequestStatusIntEnum.Mismatch:
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Error,
          TOOL_TEXT.undoing,
          changeRequestPublicId,
        );
      case Schemas.ChangeRequestStatusIntEnum.Undone:
        return HostToolsProvider.output(
          Schemas.HostToolStatusEnum.Undone,
          TOOL_TEXT.undone,
          changeRequestPublicId,
        );
      case Schemas.ChangeRequestStatusIntEnum.NeedsHuman:
      case Schemas.ChangeRequestStatusIntEnum.Resolved:
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

  // DEV_NOTE: The widget's answers to proposals (one, or a bulk review's batch: M3-5). Rate-limited per conversation
  // (DECISION_FRAMES_PER_WINDOW, one slot per frame) before any database work. Only Pending ones of this conversation
  // are decided; any other gets the change request as it stands. One at a time: the answers continue the chat, so they
  // wait for a running turn or decision, and claim the conversation (isDeciding) with no await after that check. An
  // approval needs the host token (the commit runs as the user): without one the widget gets token_needed and nothing
  // is decided. Then, in order: the database decides every one (it enforces each deadline), the approved ones are
  // committed one after another, and only then are their pauses resolved, back to back, so Think continues the chat
  // once for the whole batch (its continuation coalesces resolutions that land together).
  private async decideChangeRequests(
    ws: WebSocket,
    decisions: { changeRequestPublicId: string; decision: Schemas.ChangeRequestDecisionEnum }[],
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
    const { pending, notWaiting } = ConversationDO.matchPending(
      state,
      decisions.map((entry) => entry.changeRequestPublicId),
    );
    await this.replyNotWaiting(ws, state, notWaiting);
    if (pending.length === 0) return;
    if (this.isClosing) {
      this.reply(ws, { type: "error", message: CLOSING_MESSAGE });
      return;
    }
    if (this.isBusy()) {
      this.reply(ws, { type: "error", message: TURN_IN_PROGRESS_MESSAGE });
      return;
    }
    const decisionOf = new Map(
      decisions.map((entry) => [entry.changeRequestPublicId, entry.decision]),
    );
    const isApproving = pending.some(
      ([, entry]) => decisionOf.get(entry.publicId) === Schemas.ChangeRequestDecisionEnum.Approve,
    );
    if (isApproving && !this.hostToken) {
      this.reply(ws, {
        type: "token_needed",
        reason: Schemas.WidgetTokenNeededReasonEnum.Answer,
      });
      return;
    }

    this.isDeciding = true;
    try {
      this.patchRuntimeState({ lastActivityAt: Date.now() });
      const decided: DecidedChangeRequest[] = [];
      for (const [toolCallId, entry] of pending) {
        const decision = decisionOf.get(entry.publicId) ?? Schemas.ChangeRequestDecisionEnum.Reject;
        const status = await this.decideInDatabase(ws, toolCallId, entry, decision, false);
        if (status !== null) decided.push({ toolCallId, entry, status });
      }
      // DEV_NOTE: Every approved one is committed before any pause is resolved; its execute then answers this outcome
      for (const item of decided) {
        if (item.status !== Schemas.ChangeRequestStatusIntEnum.Approved) continue;
        const current = this.getRuntimeState()?.changeRequests[item.toolCallId];
        if (!current) continue;
        this.approvedOutputs.set(item.toolCallId, await this.runCommit(item.toolCallId, current));
      }
      await this.resolvePauses(decided);
    } finally {
      this.isDeciding = false;
    }
  }

  // DEV_NOTE: The open entries (by Think tool call id) still Pending for these public ids, and the ids that aren't
  private static matchPending(
    state: Schemas.ConversationRuntimeState,
    publicIds: string[],
  ): { pending: [string, Schemas.ConversationChangeRequestEntry][]; notWaiting: string[] } {
    const pending: [string, Schemas.ConversationChangeRequestEntry][] = [];
    const notWaiting: string[] = [];
    for (const publicId of publicIds) {
      const found = Object.entries(state.changeRequests).find(
        ([, entry]) => entry.publicId === publicId,
      );
      if (found && found[1].stage === Schemas.ConversationChangeRequestStageEnum.Pending) {
        pending.push(found);
      } else {
        notWaiting.push(publicId);
      }
    }
    return { pending, notWaiting };
  }

  // DEV_NOTE: Change requests an answer or an edit named that no longer wait: the widget gets each as it stands (so
  // its card catches up) and one error
  private async replyNotWaiting(
    ws: WebSocket,
    state: Schemas.ConversationRuntimeState,
    publicIds: string[],
  ): Promise<void> {
    if (publicIds.length === 0) return;
    const views = await this.actionEngineRepo().getChangeRequestViews({
      session: state.session,
      changeRequestPublicIds: publicIds,
    });
    for (const view of views.changeRequests ?? []) {
      this.reply(ws, { type: "change_request", changeRequest: this.withToolCallId(view) });
    }
    this.reply(ws, { type: "error", message: CHANGE_NOT_WAITING_MESSAGE });
  }

  // DEV_NOTE: The user's edits to proposals (M3-5). Same gate as an answer (rate limit, claim, host token: the edit
  // reads the record again as the user), then each edit in order (applyEdit). Nothing is approved: an edit that saves
  // leaves the proposal waiting with the re-checked diff. The widget hears every edit's outcome
  // (change_request_edit); a host token that runs out midway answers token_needed and stops there.
  private async editChangeRequests(
    ws: WebSocket,
    edits: { changeRequestPublicId: string; values: Schemas.ChangeRequestEditValues }[],
  ): Promise<void> {
    const refuseAll = (message: string) => {
      for (const edit of edits) this.replyEdit(ws, edit.changeRequestPublicId, false, message);
    };
    if (!this.takeFrameSlot("decision", Constants.DECISION_FRAMES_PER_WINDOW)) {
      refuseAll(DECISION_NOT_SAVED_MESSAGE);
      return;
    }
    const state = this.getRuntimeState();
    if (!state || state.isClosed) {
      this.sendClosed(ws);
      return;
    }
    const { pending, notWaiting } = ConversationDO.matchPending(
      state,
      edits.map((edit) => edit.changeRequestPublicId),
    );
    for (const publicId of notWaiting) {
      this.replyEdit(ws, publicId, false, CHANGE_NOT_WAITING_MESSAGE);
    }
    await this.replyNotWaiting(ws, state, notWaiting);
    if (pending.length === 0) return;
    if (this.isClosing) {
      refuseAll(CLOSING_MESSAGE);
      return;
    }
    if (this.isBusy()) {
      refuseAll(TURN_IN_PROGRESS_MESSAGE);
      return;
    }
    if (!this.hostToken) {
      this.reply(ws, {
        type: "token_needed",
        reason: Schemas.WidgetTokenNeededReasonEnum.Answer,
      });
      return;
    }

    const valuesOf = new Map(edits.map((edit) => [edit.changeRequestPublicId, edit.values]));
    this.isDeciding = true;
    try {
      this.patchRuntimeState({ lastActivityAt: Date.now() });
      for (const [toolCallId, entry] of pending) {
        const values = valuesOf.get(entry.publicId);
        if (!values) continue;
        const edited = await this.applyEdit(ws, toolCallId, entry, values);
        if (edited === "tokenNeeded") {
          this.reply(ws, {
            type: "token_needed",
            reason: Schemas.WidgetTokenNeededReasonEnum.Answer,
          });
          return;
        }
        if (edited === "closed") return;
      }
    } finally {
      this.isDeciding = false;
    }
  }

  // DEV_NOTE: One edit, re-checked like the proposal it replaces (rule 3.34), never trusting the widget: the change
  // request still Proposed before its deadline, its tool still loading (getEditPlan); only editable fields (the args
  // call_op sends, never those that pick the record); the edited args through the input_schema again; the record read
  // again as the user (none for a create); the diff rebuilt from that read and the edited args; and a diff with
  // nothing to change is refused. Then the new payload replaces the stored one (saveEdit, which re-checks the status
  // and deadline under its lock). Anything refused changes nothing, and the widget hears why in safe text.
  private async applyEdit(
    ws: WebSocket,
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    values: Schemas.ChangeRequestEditValues,
  ): Promise<"saved" | "refused" | "tokenNeeded" | "closed"> {
    const state = this.getRuntimeState();
    if (!state) return "closed";
    const repo = this.actionEngineRepo();
    const refuse = (message: string) => {
      this.replyEdit(ws, entry.publicId, false, message);
      return "refused" as const;
    };

    const planned = await repo.getEditPlan({
      session: state.session,
      changeRequestPublicId: entry.publicId,
    });
    if (!planned.isSuccess || !planned.plan) {
      this.broadcastChangeRequest(planned.changeRequest);
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.EditChangeRequest,
        message: planned.message ?? "Edit refused",
        metadata: { conversationPublicId: this.name, failure: planned.failure ?? null },
      });
      return this.refuseEditStep(ws, toolCallId, entry, planned.failure);
    }
    const { tool, payload } = planned.plan;
    const readbackOp = tool.ops.readbackOp;
    if (!readbackOp) return refuse(EDIT_UNAVAILABLE_MESSAGE);

    const applied = Schemas.applyChangeRequestEdits({
      args: payload.args,
      values,
      editableFields: ChangeRequestsProvider.editableFields(tool, payload),
    });
    if (!applied.isSuccess) return refuse(EDIT_LOCKED_MESSAGE);
    const validator = Schemas.buildToolArgsValidator(tool.ops.inputSchema);
    const validated = validator.validator
      ? Schemas.validateToolArgs(validator.validator, tool.ops.inputSchema, applied.args)
      : null;
    if (!validated?.isSuccess || !validated.args) {
      return refuse(ConversationDO.invalidEditMessage(validated?.issues ?? []));
    }
    const args = validated.args;

    let before: unknown = null;
    if (Schemas.hasReadBefore(payload.kind)) {
      const read = await HostToolCallProvider.readBefore({
        tool,
        args,
        getHostToken: () => this.hostToken,
      });
      if (
        read.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded ||
        read.outcome === Schemas.HostCallOutcomeEnum.TokenRejected
      ) {
        return "tokenNeeded";
      }
      if (read.outcome !== Schemas.HostCallOutcomeEnum.Succeeded) {
        this.logHostCall(tool, read, "Edit read-before failed");
        return refuse(EDIT_RECHECK_FAILED_MESSAGE);
      }
      before = read.body ?? null;
    }

    const changes = Schemas.buildChangeRequestChanges({
      kind: payload.kind,
      callOp: tool.ops.callOp,
      readbackOp,
      args,
      before,
    });
    if (Schemas.countChangedFields(changes) === 0) return refuse(EDIT_NO_CHANGE_MESSAGE);

    // DEV_NOTE: The args passed the input_schema and the read-before is parsed JSON; anything that isn't JSON is refused
    const edited = Schemas.ZChangeRequestPayload.safeParse({
      version: 2,
      kind: payload.kind,
      args,
      before,
      changes,
      result: null,
      mismatches: null,
    });
    if (!edited.success) return refuse(EDIT_INVALID_MESSAGE);
    const saved = await repo.saveEdit({
      session: state.session,
      changeRequestPublicId: entry.publicId,
      payload: edited.data,
      editId: Utility.generateUlid(),
    });
    this.relayEvents(saved.outboxIds);
    this.broadcastChangeRequest(saved.changeRequest);
    if (!saved.isSuccess) {
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.EditChangeRequest,
        message: saved.message ?? "Edit not saved",
        metadata: { conversationPublicId: this.name, failure: saved.failure ?? null },
      });
      return this.refuseEditStep(ws, toolCallId, entry, saved.failure);
    }
    this.replyEdit(ws, entry.publicId, true, null);
    return "saved";
  }

  // DEV_NOTE: An edit step the database refused: the widget hears why; a change request that no longer exists drops its
  // entry; a closed conversation is closed here too
  private refuseEditStep(
    ws: WebSocket,
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    failure: Schemas.ChangeRequestFailureEnum | undefined,
  ): "refused" | "closed" {
    const refuse = (message: string) => {
      this.replyEdit(ws, entry.publicId, false, message);
      return "refused" as const;
    };
    switch (failure) {
      case Schemas.ChangeRequestFailureEnum.NotFound:
        this.patchChangeRequest(toolCallId, null);
        return refuse(CHANGE_NOT_WAITING_MESSAGE);
      case Schemas.ChangeRequestFailureEnum.InvalidTransition:
      case Schemas.ChangeRequestFailureEnum.PastDeadline:
        return refuse(CHANGE_NOT_WAITING_MESSAGE);
      case Schemas.ChangeRequestFailureEnum.ConversationClosed:
        this.replyEdit(ws, entry.publicId, false, CLOSED_MESSAGE);
        this.patchRuntimeState({ isClosed: true });
        this.sendClosed(ws);
        return "closed";
      case Schemas.ChangeRequestFailureEnum.ReadOnly:
        return refuse(READ_ONLY_MESSAGE);
      case Schemas.ChangeRequestFailureEnum.ToolUnavailable:
      case Schemas.ChangeRequestFailureEnum.ChatbotUnavailable:
        return refuse(EDIT_UNAVAILABLE_MESSAGE);
      case Schemas.ChangeRequestFailureEnum.InvalidEdit:
        return refuse(EDIT_LOCKED_MESSAGE);
      default:
        return refuse(DECISION_NOT_SAVED_MESSAGE);
    }
  }

  // DEV_NOTE: Which fields didn't fit (the input_schema's own words, never a value)
  private static invalidEditMessage(issues: string[]): string {
    const fields = [...new Set(issues.map((issue) => issue.split(":")[0]?.trim()).filter(Boolean))];
    return fields.length > 0
      ? `${EDIT_INVALID_MESSAGE} Check: ${fields.slice(0, 5).join(", ")}.`
      : EDIT_INVALID_MESSAGE;
  }

  private replyEdit(
    ws: WebSocket,
    changeRequestId: string,
    isSaved: boolean,
    message: string | null,
  ): void {
    this.reply(ws, { type: "change_request_edit", changeRequestId, isSaved, message });
  }

  // DEV_NOTE: The user's undo of Verified changes (M3-7), from a card's Undo. Same gate as an answer (rate limit, the
  // conversation claimed, the host token: the undo runs as the user); a change request with no undo window here gets
  // its view as it stands and a refusal. Then each in order (runUserUndo); a host token that runs out midway answers
  // token_needed and stops there. No model call: every later turn hears what was undone (userUndos).
  private async undoChangeRequests(ws: WebSocket, publicIds: string[]): Promise<void> {
    const refuseAll = (ids: string[], message: string) => {
      for (const publicId of ids) this.replyUndo(ws, publicId, false, message);
    };
    if (!this.takeFrameSlot("decision", Constants.DECISION_FRAMES_PER_WINDOW)) {
      refuseAll(publicIds, UNDO_TEXT.notSent);
      return;
    }
    this.dropEndedUndoWindows();
    const state = this.getRuntimeState();
    if (!state || state.isClosed) {
      this.sendClosed(ws);
      return;
    }
    const windows: [string, Schemas.ConversationUndoWindow][] = [];
    const notUndoable: string[] = [];
    for (const publicId of publicIds) {
      const found = Object.entries(state.undoWindows).find(
        ([, window]) => window.publicId === publicId,
      );
      if (found) {
        windows.push(found);
      } else {
        notUndoable.push(publicId);
      }
    }
    if (notUndoable.length > 0) {
      refuseAll(notUndoable, UNDO_TEXT.notAvailable);
      const views = await this.actionEngineRepo().getChangeRequestViews({
        session: state.session,
        changeRequestPublicIds: notUndoable,
      });
      for (const view of views.changeRequests ?? []) this.broadcastChangeRequest(view);
    }
    const ids = windows.map(([, window]) => window.publicId);
    if (windows.length === 0) return;
    if (this.isClosing) {
      refuseAll(ids, CLOSING_MESSAGE);
      return;
    }
    if (this.isBusy()) {
      refuseAll(ids, TURN_IN_PROGRESS_MESSAGE);
      return;
    }
    if (!this.hostToken) {
      this.reply(ws, {
        type: "token_needed",
        reason: Schemas.WidgetTokenNeededReasonEnum.Answer,
      });
      return;
    }

    this.isDeciding = true;
    try {
      this.patchRuntimeState({ lastActivityAt: Date.now() });
      for (const [toolCallId, window] of windows) {
        const undone = await this.runUserUndo(ws, toolCallId, window);
        if (undone === "tokenNeeded") {
          this.reply(ws, {
            type: "token_needed",
            reason: Schemas.WidgetTokenNeededReasonEnum.Answer,
          });
          return;
        }
        if (undone === "closed") return;
      }
    } finally {
      this.isDeciding = false;
    }
  }

  // DEV_NOTE: One user undo: startUndo re-checks it like a commit and stores the user's undo key; an open entry (stage
  // user_undoing, given up at undo_until + CHANGE_REQUEST_UNDO_GRACE_MS) is kept from then on, so an eviction or a failed
  // write resumes it like an auto-undo (on host_token, the retry, the auto-close's check). Then runFollowUp sends
  // inverse_op as the user and reads the record again. Undone → noted for later turns (trackUndoWindow); back to
  // Verified (nothing reached the host) → the widget hears why.
  private async runUserUndo(
    ws: WebSocket,
    toolCallId: string,
    window: Schemas.ConversationUndoWindow,
  ): Promise<"started" | "refused" | "tokenNeeded" | "closed"> {
    const state = this.getRuntimeState();
    if (!state) return "closed";
    if (this.commitsInFlight.has(window.publicId)) {
      this.replyUndo(ws, window.publicId, false, UNDO_TEXT.notAvailable);
      return "refused";
    }
    const started = await this.actionEngineRepo().startUndo({
      session: state.session,
      changeRequestPublicId: window.publicId,
      attemptId: Utility.generateUlid(),
    });
    this.relayEvents(started.outboxIds);
    if (!started.isSuccess || !started.followUp) {
      this.broadcastChangeRequest(started.changeRequest);
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.UndoChangeRequest,
        message: started.message ?? "Undo refused",
        metadata: { conversationPublicId: this.name, failure: started.failure ?? null },
      });
      return this.refuseUndoStep(ws, toolCallId, window, started.failure);
    }

    const entry: Schemas.ConversationChangeRequestEntry = {
      publicId: window.publicId,
      toolName: started.followUp.tool.name,
      turnId: null,
      stage: Schemas.ConversationChangeRequestStageEnum.UserUndoing,
      expiresAt: ChangeRequestsProvider.undoGiveUpAt(window.undoUntil, Date.now()),
      executionId: null,
      expiryScheduleId: null,
      tokenNeededSince: null,
      isUnsent: false,
    };
    this.patchRuntimeState({
      changeRequests: { ...(this.getRuntimeState()?.changeRequests ?? {}), [toolCallId]: entry },
    });
    this.broadcastChangeRequest(started.changeRequest);
    this.replyUndo(ws, window.publicId, true, null);

    this.commitsInFlight.add(window.publicId);
    let run: FollowUpRun;
    try {
      run = await this.runFollowUp(toolCallId, entry, started.followUp);
    } finally {
      this.commitsInFlight.delete(window.publicId);
    }
    if (run.output.status === Schemas.HostToolStatusEnum.Verified) {
      if (
        run.undoOutcome === Schemas.HostCallOutcomeEnum.TokenNeeded ||
        run.undoOutcome === Schemas.HostCallOutcomeEnum.TokenRejected
      ) {
        return "tokenNeeded";
      }
      this.reply(ws, { type: "error", message: UNDO_TEXT.notMade });
    }
    return "started";
  }

  // DEV_NOTE: An undo the database refused (ChangeRequestsProvider.undoRefusalReply): the widget hears why (nothing
  // changed); a change request that can no longer be undone drops its window; a closed conversation is closed here too
  private refuseUndoStep(
    ws: WebSocket,
    toolCallId: string,
    window: Schemas.ConversationUndoWindow,
    failure: Schemas.ChangeRequestFailureEnum | undefined,
  ): "refused" | "closed" {
    const reply = ChangeRequestsProvider.undoRefusalReply(failure);
    if (reply.isWindowEnded) {
      const { [toolCallId]: _ended, ...undoWindows } = this.getRuntimeState()?.undoWindows ?? {};
      this.patchRuntimeState({ undoWindows });
    }
    this.replyUndo(ws, window.publicId, false, reply.message);
    if (!reply.isClosed) return "refused";
    this.patchRuntimeState({ isClosed: true });
    this.sendClosed(ws);
    return "closed";
  }

  private replyUndo(
    ws: WebSocket,
    changeRequestId: string,
    isStarted: boolean,
    message: string | null,
  ): void {
    this.reply(ws, { type: "change_request_undo", changeRequestId, isStarted, message });
  }

  // DEV_NOTE: Ends a Pending proposal by its expiry, with the conversation claimed (isDeciding) by the caller: the
  // database decides, then the pause is resolved
  private async resolvePending(
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
  ): Promise<void> {
    const status = await this.decideInDatabase(
      null,
      toolCallId,
      entry,
      Schemas.ChangeRequestDecisionEnum.Reject,
      true,
    );
    if (status !== null) await this.resolvePauses([{ toolCallId, entry, status }]);
  }

  // DEV_NOTE: One Pending proposal decided in the database: the user's answer or its expiry. The database decides first
  // (rule 3.23 re-checks; an approval after the deadline ends Expired), so a refused decision spends no budget. Then the
  // DO follows the row's status, whoever set it (a lost race, an answer whose response never arrived): Approved → its
  // entry waits for the commit; Committing → left for the commit already under way (or its resume); any end status →
  // the entry goes. The status to resolve the pause with, or null when there is nothing to resolve (kept undecided: a
  // refusal that settled nothing keeps the proposal, and an expiry is tried again on a database failure; or Committing).
  private async decideInDatabase(
    ws: WebSocket | null,
    toolCallId: string,
    entry: Schemas.ConversationChangeRequestEntry,
    decision: Schemas.ChangeRequestDecisionEnum,
    isExpired: boolean,
  ): Promise<Schemas.ChangeRequestStatusIntEnum | null> {
    const state = this.getRuntimeState();
    if (!state) return null;
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
      return null;
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
    // DEV_NOTE: A commit under way, or one that landed with its read-after or undo still to run: left to it
    const openStage = DECIDED_OPEN_STAGE[status];
    if (openStage) {
      this.patchChangeRequest(toolCallId, { stage: openStage, expiryScheduleId: null });
      return null;
    }
    const isApproved = status === Schemas.ChangeRequestStatusIntEnum.Approved;
    this.patchChangeRequest(
      toolCallId,
      isApproved
        ? { stage: Schemas.ConversationChangeRequestStageEnum.Approved, expiryScheduleId: null }
        : null,
    );
    return status;
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

  // DEV_NOTE: Resolves Think's pauses for decided change requests: approveExecution runs each action's execute (which
  // answers the commit's cached outcome, or commits) and continues the chat, rejectExecution tells the model why. The
  // continuation is prepared like a turn first, once for all of them (it continues the proposing turn, under the last
  // synced turn's id), and the pauses are resolved back to back so Think runs one continuation; one that can't be
  // prepared (budget, no key) still resolves the pauses, and its turn ends with the generic safe text. A closed
  // conversation gets no continuation (its pauses are left to Think's sweep). A pause Think no longer holds (swept,
  // resolved elsewhere) is committed here without a continuation when approved.
  private async resolvePauses(decided: DecidedChangeRequest[]): Promise<void> {
    if (decided.length === 0) return;
    const pending = await this.pendingApprovals();
    const paused: (DecidedChangeRequest & { executionId: string })[] = [];
    for (const item of decided) {
      const executionId = ConversationDO.findPendingExecutionId(pending, item.toolCallId);
      if (executionId) {
        paused.push({ ...item, executionId });
      } else {
        this.commitWithoutPause(item);
      }
    }
    if (paused.length === 0) return;

    const state = this.getRuntimeState();
    if (!state) return;
    await this.syncReadModel();
    const first = paused[0];
    const turnId = this.getRuntimeState()?.lastSyncedTurnId ?? first?.entry.turnId ?? "";
    const continuation = ConversationDO.newTurn({ requestId: "", turnId, userMessageId: null });
    const prepared = await this.prepareTurn(state.session, turnId);
    if (!prepared.isSuccess && prepared.isClosed) {
      for (const item of paused) this.commitWithoutPause(item);
      return;
    }
    if (prepared.isSuccess) {
      this.activeTurn = this.preparedTurn(continuation, prepared);
    } else {
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.DecideChangeRequest,
        message: "Continuation not prepared; the pauses are resolved without one",
        metadata: { conversationPublicId: this.name, refusal: prepared.refusal },
      });
    }
    const claimed = this.activeTurn;

    let isAnyResolved = false;
    for (const item of paused) {
      const isApproved = item.status === Schemas.ChangeRequestStatusIntEnum.Approved;
      let result: unknown;
      try {
        result = isApproved
          ? await this.approveExecution(item.executionId)
          : await this.rejectExecution(
              item.executionId,
              ConversationDO.rejectionReason(item.status),
            );
      } catch (error) {
        result = { status: "error" };
        AppLogger.error({
          category: Schemas.LogCategory.Action,
          action: Schemas.LogAction.DecideChangeRequest,
          message: "Think couldn't resolve the pause",
          error,
          metadata: {
            conversationPublicId: this.name,
            changeRequestPublicId: item.entry.publicId,
          },
        });
      }
      if (isThinkErrorResult(result)) {
        this.commitWithoutPause(item);
      } else {
        isAnyResolved = true;
      }
    }
    // DEV_NOTE: No continuation will run when Think resolved none of the pauses
    if (!isAnyResolved && claimed && this.activeTurn === claimed) this.activeTurn = null;
  }

  // DEV_NOTE: A decided change whose pause Think doesn't hold (or couldn't resolve): an approved one not yet committed
  // is committed here, its outcome reaching the widget; the model mentions it at the next message
  private commitWithoutPause(item: DecidedChangeRequest): void {
    const isApproved = item.status === Schemas.ChangeRequestStatusIntEnum.Approved;
    this.approvedOutputs.delete(item.toolCallId);
    AppLogger.warn({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.DecideChangeRequest,
      message: "Think holds no pause for this change request; resolved without a continuation",
      metadata: { conversationPublicId: this.name, changeRequestPublicId: item.entry.publicId },
    });
    const approved = this.getRuntimeState()?.changeRequests[item.toolCallId];
    if (isApproved && approved && !this.commitsInFlight.has(approved.publicId)) {
      this.ctx.waitUntil(this.runCommit(item.toolCallId, approved));
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
  // auth strategy (jwt_forward) sends the user's own token, which a wake never has until the widget sends it again;
  // without one the open sockets are asked (askForResumeToken, M3-8) and their host_token frame resumes it.
  // Its outcome reaches the widget; the paused transcript part stays as Think left it.
  private async resumeCommits(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state || state.isClosed) return;
    if (!this.hostToken) {
      await this.askForResumeToken();
      return;
    }
    for (const [toolCallId, entry] of Object.entries(state.changeRequests)) {
      if (entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending) continue;
      if (this.commitsInFlight.has(entry.publicId)) continue;
      await this.runCommit(toolCallId, entry);
    }
  }

  // DEV_NOTE: The auto-close's check while change requests are open: an expiry whose schedule never ran (past its
  // deadline by more than a retry) is run now, and approved commits are resumed. A user undo still cut short past its
  // give-up time (no host token came back to resume it) is handed to a person (M3-7), so its values are kept on
  // purpose and the conversation can close.
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
    await this.handOverTokenWaits();
    await this.resumeCommits();
    await this.abandonStaleUndos();
  }

  // DEV_NOTE: A wake with steps to resume and no host token (M3-8): every such entry starts its grace (if it hasn't), a
  // check is scheduled for its end, and the open sockets are asked for a token (their host_token frame resumes them).
  // With no socket open nothing more happens until a widget comes back or the grace ends.
  private async askForResumeToken(): Promise<void> {
    const entries = Object.entries(this.getRuntimeState()?.changeRequests ?? {}).filter(
      ([, entry]) =>
        entry.stage !== Schemas.ConversationChangeRequestStageEnum.Pending &&
        !this.commitsInFlight.has(entry.publicId),
    );
    if (entries.length === 0) return;
    for (const [toolCallId, entry] of entries) {
      if (entry.tokenNeededSince === null) await this.waitForToken(toolCallId, entry.isUnsent);
    }
    await this.tokenAsk.request();
  }

  // DEV_NOTE: A step left waiting for the host token (M3-8): its grace starts the first time (kept across later waits),
  // isUnsent says whether its last send reached nothing, and a check runs when the grace ends
  private async waitForToken(toolCallId: string, isUnsent: boolean): Promise<void> {
    const entry = this.getRuntimeState()?.changeRequests[toolCallId];
    if (!entry) return;
    const tokenNeededSince = entry.tokenNeededSince ?? Date.now();
    this.patchChangeRequest(toolCallId, { tokenNeededSince, isUnsent });
    if (entry.tokenNeededSince !== null) return;
    await this.scheduleCommitRetry(tokenNeededSince + Constants.HOST_TOKEN_GRACE_MS);
  }

  // DEV_NOTE: Every step still waiting for the host token HOST_TOKEN_GRACE_MS after it first needed it is handed to a
  // person (NeedsHuman token_needed): the widget closed, or its host gives no token. A user undo keeps its own deadline
  // (abandonStaleUndos); a step running now is left to finish.
  private async handOverTokenWaits(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    const graceStart = Date.now() - Constants.HOST_TOKEN_GRACE_MS;
    for (const [toolCallId, entry] of Object.entries(state.changeRequests)) {
      if (entry.tokenNeededSince === null || entry.tokenNeededSince > graceStart) continue;
      if (
        entry.stage === Schemas.ConversationChangeRequestStageEnum.Pending ||
        entry.stage === Schemas.ConversationChangeRequestStageEnum.UserUndoing ||
        this.commitsInFlight.has(entry.publicId)
      ) {
        continue;
      }
      const handedOver = await this.actionEngineRepo().handOverForToken({
        session: state.session,
        changeRequestPublicId: entry.publicId,
      });
      this.relayEvents(handedOver.outboxIds);
      this.broadcastChangeRequest(handedOver.changeRequest);
      if (handedOver.failure === Schemas.ChangeRequestFailureEnum.ServerError) {
        await this.scheduleCommitRetry();
        continue;
      }
      // DEV_NOTE: A refusal (the row ended meanwhile, or is gone) drops the entry too, but hands nothing over
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.HandOverChangeRequest,
        message: handedOver.isSuccess
          ? "No host token came back; handed to a person"
          : "Hand-over refused: the change request already ended",
        metadata: {
          conversationPublicId: this.name,
          changeRequestPublicId: entry.publicId,
          failure: handedOver.failure ?? null,
        },
      });
      this.patchChangeRequest(toolCallId, null);
    }
  }

  // DEV_NOTE: HostTokenAsk's ask: token_needed (reason refresh) to every open socket; how many it reached
  private askSocketsForToken(): number {
    const connections = [...this.getConnections()];
    if (connections.length === 0) return 0;
    AppLogger.info({
      category: Schemas.LogCategory.Action,
      action: Schemas.LogAction.RequestHostToken,
      message: "Host token asked of the widget",
      metadata: { conversationPublicId: this.name, connections: connections.length },
    });
    for (const connection of connections) {
      this.reply(connection, {
        type: "token_needed",
        reason: Schemas.WidgetTokenNeededReasonEnum.Refresh,
      });
    }
    return connections.length;
  }

  // DEV_NOTE: One host call as the user, tried once more with a fresh token when it found none or the host refused it
  // (M3-8), and only when a second try can't write twice: nothing may have landed, or the call is a resume (isResume:
  // the adapter reports a resume's mayHaveLanded as true even when it sent nothing, and resends it as a resume: Native
  // with the same key, Emulated checking first, None unsent). The same call runs again, so a resume stays a resume.
  // isWaiting: it still failed for want of a token and no fresh one came, so the caller waits for the token rather than
  // ending on it (a fresh token the host refused too ends as the call did). A token the host refused is dropped from
  // memory (unless a newer one came meanwhile), so the answer, edit and undo gates ask the widget for one (rule 3.37).
  private async withFreshToken(
    call: () => Promise<Schemas.HostCallResponse>,
    options: { isResume: boolean; signal?: AbortSignal },
  ): Promise<{ response: Schemas.HostCallResponse; isWaiting: boolean }> {
    const first = await this.callDroppingRejectedToken(call);
    if (!ConversationDO.isTokenRetryable(first, options.isResume)) {
      return { response: first, isWaiting: false };
    }
    if (!(await this.tokenAsk.request(options.signal))) return { response: first, isWaiting: true };
    const second = await this.callDroppingRejectedToken(call);
    return {
      response: second,
      isWaiting:
        second.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded &&
        ConversationDO.isTokenRetryable(second, options.isResume),
    };
  }

  private async callDroppingRejectedToken(
    call: () => Promise<Schemas.HostCallResponse>,
  ): Promise<Schemas.HostCallResponse> {
    const usedToken = this.hostToken;
    const called = await call();
    if (
      called.outcome === Schemas.HostCallOutcomeEnum.TokenRejected &&
      usedToken !== null &&
      this.hostToken === usedToken
    ) {
      this.hostToken = null;
    }
    return called;
  }

  private static isTokenRetryable(called: Schemas.HostCallResponse, isResume: boolean): boolean {
    return (
      (called.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded ||
        called.outcome === Schemas.HostCallOutcomeEnum.TokenRejected) &&
      (called.mayHaveLanded !== true || isResume)
    );
  }

  private async abandonStaleUndos(): Promise<void> {
    const state = this.getRuntimeState();
    if (!state) return;
    const now = Date.now();
    for (const [toolCallId, entry] of Object.entries(state.changeRequests)) {
      if (entry.stage !== Schemas.ConversationChangeRequestStageEnum.UserUndoing) continue;
      if (entry.expiresAt > now || this.commitsInFlight.has(entry.publicId)) continue;
      const abandoned = await this.actionEngineRepo().abandonUndo({
        session: state.session,
        changeRequestPublicId: entry.publicId,
      });
      this.relayEvents(abandoned.outboxIds);
      this.broadcastChangeRequest(abandoned.changeRequest);
      if (abandoned.failure === Schemas.ChangeRequestFailureEnum.ServerError) continue;
      AppLogger.warn({
        category: Schemas.LogCategory.Action,
        action: Schemas.LogAction.UndoChangeRequest,
        message: "User undo never resumed; handed to a person",
        metadata: { conversationPublicId: this.name, changeRequestPublicId: entry.publicId },
      });
      this.patchChangeRequest(toolCallId, null);
    }
  }

  // DEV_NOTE: The open change requests and those still in their undo window as they stand, to one socket (on connect).
  // A window the view no longer carries (undone elsewhere, purged) is dropped (trackUndoWindow).
  private async sendOpenChangeRequests(connection: Connection): Promise<void> {
    this.dropEndedUndoWindows();
    const state = this.getRuntimeState();
    if (!state) return;
    const publicIds = [
      ...new Set([
        ...Object.values(state.changeRequests).map((entry) => entry.publicId),
        ...Object.values(state.undoWindows).map((window) => window.publicId),
      ]),
    ];
    if (publicIds.length === 0) return;
    const views = await this.actionEngineRepo().getChangeRequestViews({
      session: state.session,
      changeRequestPublicIds: publicIds,
    });
    for (const changeRequest of views.changeRequests ?? []) {
      const view = this.withToolCallId(changeRequest);
      this.trackUndoWindow(view);
      this.send(connection, { type: "change_request", changeRequest: view });
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
  // when the bot has knowledge (M2-6), then how to act in the user's app when the turn has host tools (M3-4), then the
  // changes the user undid since the model last ran (M3-7)
  private static buildInstructions(
    spec: Schemas.ConfigSpec,
    hasHostTools: boolean,
    userUndoNotes: string[],
  ): string {
    const procedures = spec.procedures.map(
      (procedure) =>
        `### ${procedure.name}\nWhen to use: ${procedure.whenToUse}\nSteps:\n${procedure.steps}`,
    );
    return [
      spec.persona.instructions,
      procedures.length > 0 ? `## Procedures\n\n${procedures.join("\n\n")}` : null,
      ConversationDO.hasKnowledge(spec) ? SearchHelpDocsProvider.instructions : null,
      hasHostTools ? HostToolsProvider.instructions : null,
      HostToolsProvider.userUndoText(userUndoNotes),
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
  }
}
