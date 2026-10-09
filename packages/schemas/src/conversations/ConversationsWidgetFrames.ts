import z from "zod";
import { ZConversationSession } from "./ConversationsCommon";

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

// DEV_NOTE: Server-side only — what the Conversation DO keeps in its own storage between wakes: who it serves, the
// auto-close bookkeeping, and whether it is closed. Internal ids; never the host bearer token.
export const ZConversationRuntimeState = z.object({
  session: ZConversationSession,
  lastActivityAt: z.number().int(),
  hasAnswer: z.boolean(),
  closeScheduleId: z.string().nullable(),
  isClosed: z.boolean(),
});
export type ConversationRuntimeState = z.infer<typeof ZConversationRuntimeState>;
