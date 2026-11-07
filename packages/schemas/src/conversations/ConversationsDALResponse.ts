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

// DEV_NOTE: A chat the retention purge (M6-1) has to clear
export type ConversationPastRetentionRow = Pick<
  Conversation,
  | "id"
  | "publicId"
  | "companyId"
  | "chatbotUserId"
  | "status"
  | "evalRunId"
  | "evalCaseId"
  | "evalAttempt"
> & {
  // DEV_NOTE: Set = its user was erased (M6-2): due whatever its age
  erasedAt: Date | null;
};

export interface ConversationsPastRetentionDALResponse extends ApiResponse {
  conversations?: ConversationPastRetentionRow[];
}

// DEV_NOTE: The overdue alert's read of one company: past the cut-off, and since the erasure (M6-2)
export interface OverduePurgeDALResponse extends ApiResponse {
  lastActivityAt?: Date | null;
  erasedAt?: Date | null;
}

export interface OldestErasedUserPendingDALResponse extends ApiResponse {
  erasedAt?: Date | null;
}

export interface OldestConversationPastRetentionDALResponse extends ApiResponse {
  lastActivityAt?: Date | null;
}

// DEV_NOTE: One chat of the widget's history (id is internal: the Repo reads its messages with it). title is never null
// here (the read requires it).
export type WidgetConversationRow = Pick<
  Conversation,
  "id" | "publicId" | "status" | "lastActivityAt"
> & { title: string };

export interface WidgetConversationsDALResponse extends ApiResponse {
  conversations?: WidgetConversationRow[];
}

export interface WidgetConversationDALResponse extends ApiResponse {
  conversation?: WidgetConversationRow;
}
