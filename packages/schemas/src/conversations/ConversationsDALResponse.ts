import type { Conversation, DashboardConversationRow } from "./ConversationsCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";
import type { ConversationTabCounts } from "./ConversationsApiResponse";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface ConversationDALResponse extends ApiResponse {
  conversation?: Conversation;
  isConflict?: boolean;
}

// DEV_NOTE: The dashboard's rows (M4-4), with internal ids the Repo drops
export interface DashboardConversationsDALResponse extends ApiResponse {
  conversations?: DashboardConversationRow[];
}

export interface DashboardConversationDALResponse extends ApiResponse {
  conversation?: DashboardConversationRow;
}

// DEV_NOTE: Every tab's count; totalRecords = All's
export interface ConversationTabCountsDALResponse extends TotalRecordsResponse {
  tabCounts?: ConversationTabCounts;
}

// DEV_NOTE: chatbotId is internal (the Repo matches it to its chatbots)
export interface ChatbotConversationCountsDALResponse extends ApiResponse {
  counts?: { chatbotId: string; conversationCount: number }[];
}
