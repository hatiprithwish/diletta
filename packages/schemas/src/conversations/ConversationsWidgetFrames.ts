import { z } from "zod";
import type { BudgetRefusalEnum } from "../budget";
import type { ConfigSpec } from "../configSpec";
import { ZConversationSession } from "./ConversationsCommon";
import type { TurnMessage } from "../messages";
import type { KnowledgeCitation, SearchHelpDocsExcerpt } from "../knowledgeSearch";
import { ZWidgetFeedbackRating } from "../feedback";
import type { FeedbackRatingIntEnum } from "../feedback";
import { ChangeRequestDecisionEnum } from "../changeRequests/ChangeRequestsCommon";
import type { RuntimeTool } from "../toolCalls/ToolCallsCommon";

// DEV_NOTE: The longest user message the widget may send, in characters. Platform constant; the composer enforces
// it too, the DO is the guard.
export const WIDGET_MESSAGE_MAX_CHARS = 8_000;

// DEV_NOTE: The chat frames a widget may send the Conversation DO (Think's own protocol, agents MessageType
// cf_agent_*). Every other frame (clear, client-pushed messages, tool results and approvals, client state, rpc) is
// dropped: Think would let a client wipe or rewrite the transcript, or register tools.
export enum WidgetChatFrameTypeEnum {
  ChatRequest = "cf_agent_use_chat_request",
  Cancel = "cf_agent_chat_request_cancel",
  StreamResumeRequest = "cf_agent_stream_resume_request",
  StreamResumeAck = "cf_agent_stream_resume_ack",
}

export const ZWidgetFrameEnvelope = z.looseObject({
  type: z.string(),
});

// DEV_NOTE: A turn request. id is Think's request id (the turn's stream answers under it). body is a JSON string,
// parsed with ZWidgetChatRequestBody.
export const ZWidgetChatRequestFrame = z.looseObject({
  type: z.literal(WidgetChatFrameTypeEnum.ChatRequest),
  id: z.string().min(1).max(100),
  init: z.looseObject({
    method: z.literal("POST"),
    body: z.string(),
  }),
});
export type WidgetChatRequestFrame = z.infer<typeof ZWidgetChatRequestFrame>;

// DEV_NOTE: The client posts its whole transcript; only the newest message is read, and it must be a new user text
// message. Earlier messages are ignored: the DO's session is the only history. Regeneration isn't offered.
export const ZWidgetChatRequestBody = z.looseObject({
  messages: z.array(z.unknown()).min(1),
  trigger: z.literal("submit-message").optional(),
});

export const ZWidgetUserMessage = z.looseObject({
  id: z.string().trim().min(1).max(100),
  role: z.literal("user"),
  parts: z
    .array(z.looseObject({ type: z.literal("text"), text: z.string() }))
    .min(1)
    .max(20),
});
export type WidgetUserMessage = z.infer<typeof ZWidgetUserMessage>;

// DEV_NOTE: Frames passed through unchanged, once their shape checks out
export const ZWidgetPassThroughFrame = z.looseObject({
  type: z.enum([
    WidgetChatFrameTypeEnum.Cancel,
    WidgetChatFrameTypeEnum.StreamResumeRequest,
    WidgetChatFrameTypeEnum.StreamResumeAck,
  ]),
  id: z.string().min(1).max(100).optional(),
});

// DEV_NOTE: The widget's own frame next to Think's (M2-7): a thumbs up or down on one reply, named by its Think message
// id. Handled by the Conversation DO itself, never handed to Think.
export const WIDGET_FEEDBACK_FRAME_TYPE = "feedback";

export const ZWidgetFeedbackFrame = ZWidgetFeedbackRating.extend({
  type: z.literal(WIDGET_FEEDBACK_FRAME_TYPE),
});
export type WidgetFeedbackFrame = z.infer<typeof ZWidgetFeedbackFrame>;

// DEV_NOTE: The widget's host bearer token (M3-4; M3-8 fetches it when the DO asks with token_needed). The DO keeps it
// in memory only, for jwt_forward host calls made as this user: never logged, persisted or sent back. A bearer token is
// printable ASCII with no spaces (RFC 6750 b64token, plus "." for a JWT); WIDGET_HOST_TOKEN_MAX_CHARS bounds it.
export const WIDGET_HOST_TOKEN_FRAME_TYPE = "host_token";
export const WIDGET_HOST_TOKEN_MAX_CHARS = 8_192;

export const ZWidgetHostTokenFrame = z.object({
  type: z.literal(WIDGET_HOST_TOKEN_FRAME_TYPE),
  token: z
    .string()
    .min(1)
    .max(WIDGET_HOST_TOKEN_MAX_CHARS)
    .regex(/^[\w.~+/-]+=*$/),
});
export type WidgetHostTokenFrame = z.infer<typeof ZWidgetHostTokenFrame>;

// DEV_NOTE: The user's answer to one proposal (M3-4; the widget's review UI is M3-5), named by the change request's
// public id. Handled by the Conversation DO itself, never handed to Think.
export const WIDGET_CHANGE_REQUEST_DECISION_FRAME_TYPE = "change_request_decision";

export const ZWidgetChangeRequestDecisionFrame = z.object({
  type: z.literal(WIDGET_CHANGE_REQUEST_DECISION_FRAME_TYPE),
  changeRequestId: z.string().trim().min(1).max(64),
  decision: z.enum(ChangeRequestDecisionEnum),
});
export type WidgetChangeRequestDecisionFrame = z.infer<typeof ZWidgetChangeRequestDecisionFrame>;

// DEV_NOTE: Server-side only — what the widget frame allowlist decided (WidgetFrameProvider.admit). pass: hand the
// frame on unchanged. chat: a new user turn; frame is the rebuilt request carrying only that message. feedback: a
// rating for the DO to store. hostToken: the user's host token for the DO's memory. decision: an answer to a
// proposal. refuse: drop it and tell the widget (reason is logged only, and never holds the frame's content).
export type WidgetFrameAdmission =
  | { kind: "pass"; frame: string }
  | { kind: "chat"; requestId: string; message: { id: string; text: string }; frame: string }
  | { kind: "feedback"; messageId: string; rating: FeedbackRatingIntEnum }
  | { kind: "hostToken"; token: string }
  | { kind: "decision"; changeRequestPublicId: string; decision: ChangeRequestDecisionEnum }
  | { kind: "refuse"; reason: string };

// DEV_NOTE: Server-side only — one Think transcript message reduced to what the read model keeps (TranscriptProvider).
// searchCitations are the results of the message's search_help_docs calls (citation fields only); unsyncedTurns keeps
// the ones a reply's text cites, from any search of its turn.
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "other";
  text: string;
  searchCitations: KnowledgeCitation[];
}

// DEV_NOTE: Server-side only — the next slice of the transcript to write to the read model: one turn (a user message
// and what followed it) with the ULID it was admitted under (a new one when that was lost, e.g. after an eviction).
// userMessageId is null for a slice with no user message: a reply that arrived after its user message was synced,
// written under the last synced turn's id. title is the user message's text, cut to the title length. lastEntryId is
// the last transcript message the turn covers: the new sync position once it is written.
export interface TranscriptTurn {
  turnId: string;
  userMessageId: string | null;
  messages: TurnMessage[];
  title: string | null;
  lastEntryId: string;
}

// DEV_NOTE: Server-side only — the turns to write, or isPositionLost when the last synced message isn't in the
// transcript Think loaded (an empty or windowed view): nothing is written until it is, rather than guess
export interface UnsyncedTranscript {
  turns: TranscriptTurn[];
  isPositionLost: boolean;
}

// DEV_NOTE: Server-side only — the turn the Conversation DO is preparing or running (at most one). TModel is the AI
// SDK LanguageModel (@app/schemas doesn't depend on it); TCaps the turn's budget (TurnBudget, M2-4). model,
// spec and caps are null while the turn is being prepared. citationCount is how many search results the turn has
// numbered so far (M2-6), so a second search goes on from [n + 1]; searchExcerpts holds each of the turn's searches'
// excerpts by tool call id, for the model only (the tool's output carries citations alone).
//
// Actions (M3-4): userMessageId is null for a continuation (the turn Think runs after an approval, a rejection or an
// expiry: it has no user message, and its requestId is Think's own, so isContinuation matches the first turn end
// Think reports for it; the DO's own fallback end of a widget request never does). tools are the config's loaded host tools. isUntrusted: the turn holds untrusted content (help docs or host data
// read in this or an earlier turn), so every write needs approval. toolCallKeys are the turn's host calls (tool name +
// args), for the loop guard; isLoopStopped ends the turn's loop once one repeats. startedAt (epoch ms) lets a
// continuation Think never ran be dropped instead of holding the conversation.
export interface ActiveTurn<TModel, TCaps> {
  requestId: string;
  startedAt: number;
  turnId: string;
  userMessageId: string | null;
  isContinuation: boolean;
  model: TModel | null;
  spec: ConfigSpec | null;
  caps: TCaps | null;
  tools: RuntimeTool[];
  citationCount: number;
  searchExcerpts: Record<string, SearchHelpDocsExcerpt[]>;
  isUntrusted: boolean;
  toolCallKeys: string[];
  isLoopStopped: boolean;
}

// DEV_NOTE: Server-side only — a prepared turn's config, routed model and budget, or why it can't run (isClosed: the
// conversation was closed elsewhere; refusal: a budget or rate limit said no, null for any other failure)
export type PreparedTurn<TModel, TCaps> =
  | { isSuccess: true; spec: ConfigSpec; model: TModel; caps: TCaps; tools: RuntimeTool[] }
  | { isSuccess: false; isClosed: boolean; refusal: BudgetRefusalEnum | null };

// DEV_NOTE: Server-side only — one open change request in the Conversation DO's state (M3-4), by Think tool call id.
// Pending: proposed, waiting for the user until expiresAt (expiryScheduleId is its DO schedule). Approved: committed
// without a pause, or approved and handed to Think. Committing: its commit started; one still Committing on a wake
// was cut by an eviction and is resumed. executionId is Think's durable-pause id, read after the turn parks. turnId is
// the turn that proposed it.
export enum ConversationChangeRequestStageEnum {
  Pending = "pending",
  Approved = "approved",
  Committing = "committing",
}

export const ZConversationChangeRequestEntry = z.object({
  publicId: z.string(),
  toolName: z.string(),
  turnId: z.string(),
  stage: z.enum(ConversationChangeRequestStageEnum),
  expiresAt: z.number().int(),
  executionId: z.string().nullable(),
  expiryScheduleId: z.string().nullable(),
});
export type ConversationChangeRequestEntry = z.infer<typeof ZConversationChangeRequestEntry>;

// DEV_NOTE: Server-side only — the verified companion JWT's roles and its exp (epoch ms), from the worker to the
// Conversation DO in a header only the worker sets (Constants.CONVERSATION_ROLES_HEADER)
export const ZConversationRolesGrant = z.object({
  roles: z.array(z.string()),
  expiresAt: z.number().int(),
});
export type ConversationRolesGrant = z.infer<typeof ZConversationRolesGrant>;

// DEV_NOTE: Server-side only — what the Conversation DO keeps in its own storage between wakes: who it serves, the
// auto-close bookkeeping, whether it is closed, and the read-model sync position. lastSyncedMessageId is the last
// transcript message written to messages (an id, not an index: Think may load an empty or windowed view); turnIds maps
// a user message id to the turn ULID it was admitted under, until that turn is synced; lastSyncedTurnId takes a late
// reply. Budget (M2-4): turnStartedAts holds the start times of the turns admitted in the last hour
// (conversationTurnsPerHour) and spentMicros the conversation's settled model spend (conversationCostCapUsd), both
// defaulted so a conversation stored before M2-4 still parses. Actions (M3-4): roles are the host user's roles from
// the newest connect's companion JWT (approval rules match them), and count only until rolesExpiresAt (epoch ms, that
// JWT's exp; after it the user has no roles until a fresh connect); changeRequests holds this conversation's open
// change requests by Think tool call id until they end. Internal ids only; never the host bearer token.
export const ZConversationRuntimeState = z.object({
  session: ZConversationSession,
  lastActivityAt: z.number().int(),
  hasAnswer: z.boolean(),
  closeScheduleId: z.string().nullable(),
  isClosed: z.boolean(),
  lastSyncedMessageId: z.string().nullable(),
  turnIds: z.record(z.string(), z.string()),
  lastSyncedTurnId: z.string().nullable(),
  turnStartedAts: z.array(z.number().int()).default([]),
  spentMicros: z.number().int().min(0).default(0),
  roles: z.array(z.string()).default([]),
  rolesExpiresAt: z.number().int().default(0),
  changeRequests: z.record(z.string(), ZConversationChangeRequestEntry).default({}),
});
export type ConversationRuntimeState = z.infer<typeof ZConversationRuntimeState>;
