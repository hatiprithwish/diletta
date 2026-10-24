import type { Message } from "./MessagesCommon";
import type { ApiResponse } from "../common";
import type { FeedbackRatingIntEnum } from "../feedback/FeedbackCommon";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface MessagesDALResponse extends ApiResponse {
  messages?: Message[];
}

export interface MessageDALResponse extends ApiResponse {
  chatMessage?: Message;
}

// DEV_NOTE: A transcript message with its user's thumb (one rating per reply per user), for the dashboard (M4-4)
export type TranscriptMessageRow = Message & { rating: FeedbackRatingIntEnum | null };

export interface TranscriptMessagesDALResponse extends ApiResponse {
  messages?: TranscriptMessageRow[];
}
