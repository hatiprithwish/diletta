import type { ApiResponse } from "../common";
import type { WidgetFeedbackRating } from "./FeedbackCommon";

// DEV_NOTE: Server-side only (FeedbackRepo → Conversation DO). isNotFound: no synced reply of this conversation has
// that message id (not a reply, still streaming, or someone else's); the widget is told the rating wasn't saved.
export interface RecordFeedbackResponse extends ApiResponse {
  rating?: WidgetFeedbackRating;
}

export interface ConversationFeedbackResponse extends ApiResponse {
  ratings?: WidgetFeedbackRating[];
}
