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
