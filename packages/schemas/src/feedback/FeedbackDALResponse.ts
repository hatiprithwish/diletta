import type { ApiResponse } from "../common";
import type { Feedback, WidgetFeedbackRating } from "./FeedbackCommon";

// DAL results carry the raw DB row (internal ids + rating int). The Repo maps them to what the widget sees.
export interface FeedbackDALResponse extends ApiResponse {
  feedback?: Feedback;
}

// DEV_NOTE: Already reduced to the reply's Think message id and the rating: that's all a reader of this list needs
export interface ConversationFeedbackDALResponse extends ApiResponse {
  ratings?: WidgetFeedbackRating[];
}
