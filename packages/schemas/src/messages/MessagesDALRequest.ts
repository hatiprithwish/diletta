import type { PageDALRequest } from "../common";
import type { Message, TurnMessage } from "./MessagesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. One turn's
// messages in one insert; a message already stored (same conversation and sessionMessageId) is skipped, so a retried
// write never duplicates it. The DAL generates publicIds and checks the conversation exists.
export type CreateMessagesDALRequest = Pick<Message, "companyId" | "conversationId" | "turnId"> & {
  messages: TurnMessage[];
};

// DEV_NOTE: A conversation's transcript in order (created_at, then id). Paged: a long chat grows without bound.
export type GetMessagesDALRequest = Pick<Message, "companyId" | "conversationId"> & PageDALRequest;
