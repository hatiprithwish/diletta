import type { Message, TurnMessage } from "./MessagesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. One turn's
// messages in one insert; a message already stored (same conversation and sessionMessageId) is skipped, so a retried
// write never duplicates it. The DAL generates publicIds and checks the conversation exists.
export type CreateMessagesDALRequest = Pick<Message, "companyId" | "conversationId" | "turnId"> & {
  messages: TurnMessage[];
};

// DEV_NOTE: One reply of a conversation by its Think message id (conversationId is internal, from the session)
export type FindAssistantMessageDALRequest = Pick<
  Message,
  "companyId" | "conversationId" | "sessionMessageId"
>;

// DEV_NOTE: Every message of one conversation, oldest first (the dashboard transcript, M4-4)
export type ListConversationMessagesDALRequest = Pick<Message, "companyId" | "conversationId">;

// DEV_NOTE: A quality issue's messages (M4-6): the newest `limit` user and assistant messages of one conversation, up
// to and including upToMessageId (the rated reply; null = the whole conversation), returned oldest first
export type ListRecentChatMessagesDALRequest = Pick<Message, "companyId" | "conversationId"> & {
  upToMessageId: string | null;
  limit: number;
};
