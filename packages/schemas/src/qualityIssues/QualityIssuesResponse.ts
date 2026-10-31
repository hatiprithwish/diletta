import type { ApiResponse } from "../common";
import type { FlagConversationApiResponse } from "../conversations/ConversationsApiResponse";
import type { UpdateQualityIssueApiResponse } from "./QualityIssuesApiResponse";

// DEV_NOTE: Server-side only (UserQualityIssueProvider → FeedbackRepo). qualityIssueId and outboxId are set when this
// thumbs-down opened the issue; both stay unset when the feedback row already had one. outboxId is relayed after commit.
export interface OpenUserQualityIssueResponse extends ApiResponse {
  qualityIssueId?: string;
  outboxId?: string;
}

// DEV_NOTE: Server-side only. The route relays outboxId after the commit and answers the rest
// (FlagConversationApiResponse); outboxId is set only when the flag opened an issue.
export interface FlagConversationResponse extends FlagConversationApiResponse {
  outboxId?: string;
}

// DEV_NOTE: Server-side only (QualityIssuesRepo → route, M4-6): the route relays outboxId after the commit and answers
// the rest
export interface UpdateQualityIssueResponse extends UpdateQualityIssueApiResponse {
  outboxId?: string;
}
