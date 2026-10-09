import z from "zod";
import { ZConversationSession } from "./ConversationsCommon";
import type { TurnMessage } from "../messages";

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

// DEV_NOTE: Server-side only — what the widget frame allowlist decided (WidgetFrameProvider.admit). pass: hand the
// frame on unchanged. chat: a new user turn; frame is the rebuilt request carrying only that message. refuse: drop it
// and tell the widget (reason is logged only).
export type WidgetFrameAdmission =
  | { kind: "pass"; frame: string }
  | { kind: "chat"; requestId: string; message: { id: string; text: string }; frame: string }
  | { kind: "refuse"; reason: string };

// DEV_NOTE: Server-side only — one Think transcript message reduced to what the read model keeps (TranscriptProvider)
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "other";
  text: string;
}

// DEV_NOTE: Server-side only — the next slice of the transcript to write to the read model: one turn (a user message
// and what followed it) with the ULID it was admitted under (a new one when that was lost, e.g. after an eviction).
// userMessageId is null for a slice with no user message: a reply that arrived after its user message was synced,
// written under the last synced turn's id. title is the user message's text, cut to the title length.
export interface TranscriptTurn {
  turnId: string;
  userMessageId: string | null;
  messages: TurnMessage[];
  title: string | null;
  // Number of transcript entries this turn covers, to advance the synced count
  entryCount: number;
}

// DEV_NOTE: Server-side only — what the Conversation DO keeps in its own storage between wakes: who it serves, the
// auto-close bookkeeping, whether it is closed, and the read-model sync position. syncedMessageCount is how many
// transcript messages (in order) are in messages; turnIds maps a user message id to the turn ULID it was admitted
// under, until that turn is synced; lastSyncedTurnId takes a late reply. Internal ids only; never the host bearer
// token.
export const ZConversationRuntimeState = z.object({
  session: ZConversationSession,
  lastActivityAt: z.number().int(),
  hasAnswer: z.boolean(),
  closeScheduleId: z.string().nullable(),
  isClosed: z.boolean(),
  syncedMessageCount: z.number().int().min(0),
  turnIds: z.record(z.string(), z.string()),
  lastSyncedTurnId: z.string().nullable(),
});
export type ConversationRuntimeState = z.infer<typeof ZConversationRuntimeState>;
