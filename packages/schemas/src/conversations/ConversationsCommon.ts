import { z } from "zod";

export enum ConversationStatusIntEnum {
  Open = 1,
  Closed = 2,
}

export enum ConversationStatusLabelEnum {
  Open = "Open",
  Closed = "Closed",
}

export const CONVERSATION_STATUS_LABEL_MAP: Record<
  ConversationStatusIntEnum,
  ConversationStatusLabelEnum
> = {
  [ConversationStatusIntEnum.Open]: ConversationStatusLabelEnum.Open,
  [ConversationStatusIntEnum.Closed]: ConversationStatusLabelEnum.Closed,
};

export enum ConversationOutcomeIntEnum {
  Answered = 1,
  ActionDone = 2,
  Idk = 3,
  Handoff = 4,
  Abandoned = 5,
}

export enum ConversationOutcomeLabelEnum {
  Answered = "Answered",
  ActionDone = "Action done",
  Idk = "I don't know",
  Handoff = "Handoff",
  Abandoned = "Abandoned",
}

export const CONVERSATION_OUTCOME_LABEL_MAP: Record<
  ConversationOutcomeIntEnum,
  ConversationOutcomeLabelEnum
> = {
  [ConversationOutcomeIntEnum.Answered]: ConversationOutcomeLabelEnum.Answered,
  [ConversationOutcomeIntEnum.ActionDone]: ConversationOutcomeLabelEnum.ActionDone,
  [ConversationOutcomeIntEnum.Idk]: ConversationOutcomeLabelEnum.Idk,
  [ConversationOutcomeIntEnum.Handoff]: ConversationOutcomeLabelEnum.Handoff,
  [ConversationOutcomeIntEnum.Abandoned]: ConversationOutcomeLabelEnum.Abandoned,
};

// Whole Conversation Body — DB shape (enums stored as integers)
// DEV_NOTE: publicId is also the Conversation DO's name. id, companyId, chatbotUserId, chatbotId, chatbotConfigId and
// rootLogId are internal bigint ids — used by DAL/Repo only, NEVER sent to a client. title comes from the first user
// message (chat content: purged with it).
export const ZConversation = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotUserId: z.string(),
  chatbotId: z.string(),
  chatbotConfigId: z.string().nullable(),
  status: z.enum(ConversationStatusIntEnum),
  outcome: z.enum(ConversationOutcomeIntEnum).nullable(),
  title: z.string().nullable(),
  lastActivityAt: z.date(),
  rootLogId: z.string().nullable(),
  contentPurgedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Conversation = z.infer<typeof ZConversation>;

// DEV_NOTE: Server-side only — who a Conversation DO serves. The widget route builds it from the verified
// WidgetIdentity and the conversation row, and hands it to the DO in a header only the worker sets (the DO has no
// public route). Internal ids, so it never reaches the widget; the DO keeps it in its own storage, never the host
// token (there is none here).
export const ZConversationSession = z.object({
  companyId: z.string().min(1),
  chatbotId: z.string().min(1),
  chatbotPublicId: z.string().min(1),
  chatbotName: z.string(),
  chatbotUserId: z.string().min(1),
  conversationId: z.string().min(1),
  conversationPublicId: z.string().min(1),
});
export type ConversationSession = z.infer<typeof ZConversationSession>;
