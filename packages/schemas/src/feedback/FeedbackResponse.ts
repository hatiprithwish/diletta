import type { ApiResponse } from "../common";
import type {
  RecordFeedbackFailureEnum,
  WidgetFeedbackRating,
  WidgetFeedbackRatingState,
} from "./FeedbackCommon";

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
  ratings?: WidgetFeedbackRatingState[];
}

// DEV_NOTE: Server-side only (FeedbackRepo → Conversation DO): whether the note on a rating was stored, or why not.
// outboxId (internal) is its feedback.note_added event (M7-10), for the DO to relay after the commit.
export interface RecordFeedbackNoteResponse extends ApiResponse {
  failure?: RecordFeedbackFailureEnum;
  outboxId?: string;
}
