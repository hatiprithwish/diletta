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

// DEV_NOTE: The longest feedback note a visitor may leave on a rating, in characters (trimmed). Platform constant; the
// widget's note box enforces it too, the DO is the guard.
export const FEEDBACK_NOTE_MAX_CHARS = 1_000;

// DEV_NOTE: Why a rating (or its note) wasn't stored (server-side only, FeedbackRepo → Conversation DO). NotFound: no
// synced reply of this conversation has that message id, or (a note) the user hasn't rated it. ConversationClosed: the conversation is no longer open (the widget is told
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
// the reply by its Think message id. comment is the visitor's optional note on the rating (≤ FEEDBACK_NOTE_MAX_CHARS),
// cleared when they switch thumbs and by the retention purge; raw user text, so never logged or put in an event.
export const ZFeedback = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  messageId: z.string(),
  chatbotUserId: z.string(),
  rating: z.enum(FeedbackRatingIntEnum),
  comment: z.string().nullable(),
  commentVersion: z.number().int(),
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

// DEV_NOTE: Client-facing — a rating as the conversation frame sends it on connect: hasNote says the visitor left a
// note on it (the text itself stays out of the frame and the header it travels in)
export const ZWidgetFeedbackRatingState = ZWidgetFeedbackRating.extend({
  hasNote: z.boolean().default(false),
});
export type WidgetFeedbackRatingState = z.infer<typeof ZWidgetFeedbackRatingState>;

export const ZWidgetFeedbackRatings = z.array(ZWidgetFeedbackRatingState);

// DEV_NOTE: Client-facing — a visitor's note on their rating of one reply (M7-10), trimmed, 1 to FEEDBACK_NOTE_MAX_CHARS
export const ZWidgetFeedbackNote = z.object({
  messageId: z.string().min(1).max(100),
  note: z.string().trim().min(1).max(FEEDBACK_NOTE_MAX_CHARS),
});
export type WidgetFeedbackNote = z.infer<typeof ZWidgetFeedbackNote>;
