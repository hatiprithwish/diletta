import type { ApiResponse } from "../common";
import type { RecordFeedbackFailureEnum, WidgetFeedbackRating } from "./FeedbackCommon";

// DEV_NOTE: Server-side only (FeedbackRepo → Conversation DO). failure says why nothing was stored (NotFound: not a
// reply, still streaming, or someone else's); the widget is told the rating wasn't saved.
export interface RecordFeedbackResponse extends ApiResponse {
  rating?: WidgetFeedbackRating;
  failure?: RecordFeedbackFailureEnum;
}

export interface ConversationFeedbackResponse extends ApiResponse {
  ratings?: WidgetFeedbackRating[];
}
