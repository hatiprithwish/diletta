import z from "zod";
import { ZKnowledgeCitation } from "../knowledgeSearch";

export enum MessageRoleIntEnum {
  User = 1,
  Assistant = 2,
  Tool = 3,
}

export enum MessageRoleLabelEnum {
  User = "User",
  Assistant = "Assistant",
  Tool = "Tool",
}

export const MESSAGE_ROLE_LABEL_MAP: Record<MessageRoleIntEnum, MessageRoleLabelEnum> = {
  [MessageRoleIntEnum.User]: MessageRoleLabelEnum.User,
  [MessageRoleIntEnum.Assistant]: MessageRoleLabelEnum.Assistant,
  [MessageRoleIntEnum.Tool]: MessageRoleLabelEnum.Tool,
};

// DEV_NOTE: messages.content — what the read model keeps of one Think message: its text and, for a reply that used
// knowledge (M2-6), the sources its [n] markers cite (absent when it cites none). Attachment file ids join it with
// uploads. Nulled when the chat is purged.
export const ZMessageContent = z.object({
  text: z.string(),
  citations: z.array(ZKnowledgeCitation).optional(),
});
export type MessageContent = z.infer<typeof ZMessageContent>;

// Whole Message Body — DB shape (enums stored as integers)
// DEV_NOTE: The read model of the Think transcript (the DO's session is the source of truth), written after each turn
// and never read into a turn. sessionMessageId is Think's message id, unique per conversation; turnId is the ULID the
// user message and its reply share. id, companyId and conversationId are internal — NEVER sent to a client. content is
// jsonb, which drizzle reads untyped.
export const ZMessage = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  conversationId: z.string(),
  sessionMessageId: z.string(),
  turnId: z.string(),
  role: z.enum(MessageRoleIntEnum),
  content: z.unknown(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Message = z.infer<typeof ZMessage>;

// DEV_NOTE: Server-side only — one transcript message for the read model, from the Conversation DO
export interface TurnMessage {
  sessionMessageId: string;
  role: MessageRoleIntEnum;
  content: MessageContent;
}
