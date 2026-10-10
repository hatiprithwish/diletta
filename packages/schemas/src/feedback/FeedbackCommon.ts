import { z } from "zod";

export enum FeedbackRatingIntEnum {
  Up = 1,
  Down = 2,
}

export enum FeedbackRatingLabelEnum {
  Up = "Up",
  Down = "Down",
}

export const FEEDBACK_RATING_LABEL_MAP: Record<FeedbackRatingIntEnum, FeedbackRatingLabelEnum> = {
  [FeedbackRatingIntEnum.Up]: FeedbackRatingLabelEnum.Up,
  [FeedbackRatingIntEnum.Down]: FeedbackRatingLabelEnum.Down,
};

// DEV_NOTE: Why a rating wasn't stored (server-side only, FeedbackRepo → Conversation DO). NotFound: no synced reply of
// this conversation has that message id. ConversationClosed: the conversation is no longer open (the widget is told
// it closed). ChatbotUnavailable: the company or chatbot is no longer active.
export enum RecordFeedbackFailureEnum {
  NotFound = "NotFound",
  ConversationClosed = "ConversationClosed",
  ChatbotUnavailable = "ChatbotUnavailable",
  ServerError = "ServerError",
}

// Whole Feedback Body — DB shape (rating stored as integer)
// DEV_NOTE: A visitor's thumbs up or down on one reply (M2-7): one row per (message, chatbot user), changed in place
// when they switch. id, companyId, messageId and chatbotUserId are internal — NEVER sent to a client; the widget names
// the reply by its Think message id. comment is unused until a comment box exists.
export const ZFeedback = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  messageId: z.string(),
  chatbotUserId: z.string(),
  rating: z.enum(FeedbackRatingIntEnum),
  comment: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Feedback = z.infer<typeof ZFeedback>;

// DEV_NOTE: Client-facing — the visitor's rating of one reply, by the reply's Think message id (the id the widget's
// transcript carries). Sent on connect for the conversation's rated replies and as the ack of a feedback frame.
export const ZWidgetFeedbackRating = z.object({
  messageId: z.string().min(1).max(100),
  rating: z.enum(FeedbackRatingIntEnum),
});
export type WidgetFeedbackRating = z.infer<typeof ZWidgetFeedbackRating>;

export const ZWidgetFeedbackRatings = z.array(ZWidgetFeedbackRating);
