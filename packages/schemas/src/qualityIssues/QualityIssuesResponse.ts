import type { ApiResponse } from "../common";

// DEV_NOTE: Server-side only (UserQualityIssueProvider → FeedbackRepo). qualityIssueId and outboxId are set when this
// thumbs-down opened the issue; both stay unset when the feedback row already had one. outboxId is relayed after commit.
export interface OpenUserQualityIssueResponse extends ApiResponse {
  qualityIssueId?: string;
  outboxId?: string;
}
