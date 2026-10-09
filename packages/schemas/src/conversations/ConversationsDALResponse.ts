import type { Conversation } from "./ConversationsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface ConversationDALResponse extends ApiResponse {
  conversation?: Conversation;
}
