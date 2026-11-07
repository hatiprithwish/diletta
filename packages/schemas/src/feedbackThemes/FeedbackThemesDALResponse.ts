import type { ApiResponse } from "../common";
import type { ConfigSpec } from "../configSpec";
import type { FeedbackRatingIntEnum } from "../feedback/FeedbackCommon";
import type {
  FeedbackNote,
  FeedbackNoteAddedDetail,
  FeedbackNoteRewriteSource,
  FeedbackTheme,
} from "./FeedbackThemesCommon";

export interface FeedbackThemeDALResponse extends ApiResponse {
  feedbackTheme?: FeedbackTheme;
}

// DEV_NOTE: The nearest theme with its centroid and how close it is (the clustering's own read)
export interface NearestFeedbackThemeDALResponse extends ApiResponse {
  feedbackTheme?: FeedbackTheme & { centroid: number[]; similarity: number };
}

export interface FeedbackNoteDALResponse extends ApiResponse {
  feedbackNote?: FeedbackNote;
}

// DEV_NOTE: The note a delete removed, if any: its theme loses it
export interface DeletedFeedbackNoteDALResponse extends ApiResponse {
  themeId?: string | null;
}

export interface FeedbackThemeUserCountDALResponse extends ApiResponse {
  userCount?: number;
}

// DEV_NOTE: A stored note as the clustering reads it. comment null = the note is gone (cleared by a thumb switch or the
// purge). replyText null = the reply's content was purged. isEval: the conversation is an eval run's.
export interface FeedbackNoteSource {
  feedbackPublicId: string;
  rating: FeedbackRatingIntEnum;
  comment: string | null;
  commentVersion: number;
  chatbotUserId: string;
  conversationId: string;
  chatbotId: string;
  replyText: string | null;
  isEval: boolean;
}

export interface FeedbackNoteSourceDALResponse extends ApiResponse {
  source?: FeedbackNoteSource;
}

// DEV_NOTE: A note's handling (FeedbackThemesRepo.processNote). isSuccess false = try the message again (a provider or
// database failure); a note that can't ever be grouped (gone or edited since, not specific, budget, no key, no published
// config) is a success with isDropped, logged where it is decided. isThemed = this call put the note in a theme.
export interface ProcessFeedbackNoteResponse extends ApiResponse {
  outboxIds?: string[];
  isDropped?: boolean;
  isThemed?: boolean;
  qualityIssueOpened?: boolean;
}

// DEV_NOTE: Server-side only — what processNote works from. No ready = nothing to do (message says why);
// pendingNote set = an earlier attempt already stored this version's summary, so source and routing aren't read.
export interface FeedbackNoteReady {
  detail: FeedbackNoteAddedDetail;
  companyPublicId: string;
  note: Pick<FeedbackNoteSource, "rating" | "chatbotUserId" | "conversationId" | "chatbotId">;
  pendingNote: FeedbackNote | null;
  source: FeedbackNoteRewriteSource | null;
  routing: ConfigSpec["routing"] | null;
}

export interface FeedbackNoteInputsResponse extends ApiResponse {
  ready?: FeedbackNoteReady;
}

export interface OpenFeedbackThemeQualityIssueRequest {
  companyId: string;
  chatbotId: string;
  feedbackThemeId: string;
  label: string;
}

export interface OpenFeedbackThemeQualityIssueResponse extends ApiResponse {
  isOpened?: boolean;
  outboxId?: string;
}
