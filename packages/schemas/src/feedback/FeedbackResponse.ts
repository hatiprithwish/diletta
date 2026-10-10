import type { ApiResponse } from "../common";
import type { RecordFeedbackFailureEnum, WidgetFeedbackRating } from "./FeedbackCommon";

// DEV_NOTE: Server-side only (FeedbackRepo → Conversation DO). failure says why nothing was stored (NotFound: not a
// reply, still streaming, or someone else's); the widget is told the rating wasn't saved. outboxId (internal) is the
// quality_issue.opened event a thumbs-down recorded (M2-8), for the DO to relay after the commit; absent when the
// rating opened no issue.
export interface RecordFeedbackResponse extends ApiResponse {
  rating?: WidgetFeedbackRating;
  failure?: RecordFeedbackFailureEnum;
  outboxId?: string;
}

export interface ConversationFeedbackResponse extends ApiResponse {
  ratings?: WidgetFeedbackRating[];
}
