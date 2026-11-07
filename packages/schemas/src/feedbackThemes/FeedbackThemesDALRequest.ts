import type { PageDALRequest } from "../common";
import type { AuditActor } from "../auditLog/AuditLogCommon";
import type { QualityIssueCloseStatus } from "../qualityIssues";
import type {
  FeedbackNote,
  FeedbackTheme,
  FeedbackThemeSortColumn,
  FeedbackThemeStatusIntEnum,
} from "./FeedbackThemesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.

// DEV_NOTE: One clustering at a time per chatbot and thumb (until the commit)
export type LockFeedbackThemingDALRequest = Pick<
  FeedbackTheme,
  "companyId" | "chatbotId" | "rating"
>;

// DEV_NOTE: The chatbot's closest Open or Dismissed theme of the same thumb a note may join
export type FindNearestFeedbackThemeDALRequest = Pick<
  FeedbackTheme,
  "companyId" | "chatbotId" | "rating"
> & {
  embedding: number[];
};

export type CreateFeedbackThemeDALRequest = Pick<
  FeedbackTheme,
  "companyId" | "chatbotId" | "rating" | "label"
> & {
  centroid: number[];
};

export type GrowFeedbackThemeDALRequest = Pick<FeedbackTheme, "companyId" | "id" | "noteCount"> & {
  centroid: number[];
};

// DEV_NOTE: A note left its theme (edited, cleared by a thumb switch): one fewer, never below 0
export type ShrinkFeedbackThemeDALRequest = Pick<FeedbackTheme, "companyId" | "id">;

// DEV_NOTE: A note's summary, pending, replacing any earlier one for the same feedback row (an edit)
export type UpsertFeedbackNoteDALRequest = Pick<
  FeedbackNote,
  | "companyId"
  | "chatbotId"
  | "feedbackId"
  | "conversationId"
  | "chatbotUserId"
  | "rating"
  | "commentVersion"
  | "summary"
>;

export type GetFeedbackNoteByFeedbackDALRequest = Pick<FeedbackNote, "companyId" | "feedbackId">;

export type DeleteFeedbackNoteDALRequest = Pick<FeedbackNote, "companyId" | "feedbackId">;

// DEV_NOTE: A pending note into its theme, with the embedding that placed it
export type AttachFeedbackNoteDALRequest = Pick<FeedbackNote, "companyId" | "id"> & {
  themeId: string;
  embedding: number[];
};

export type CountFeedbackThemeUsersDALRequest = Pick<FeedbackNote, "companyId"> & {
  themeId: string;
};

// DEV_NOTE: What the clustering reads about a stored note: the feedback row (its current note version and text, the
// thumb) and the reply it rates, with that reply's conversation and chatbot
export interface GetFeedbackNoteSourceDALRequest {
  companyId: string;
  feedbackId: string;
}

export type GetFeedbackThemesDALRequest = Pick<FeedbackTheme, "companyId" | "rating" | "status"> &
  PageDALRequest & { sortColumn: FeedbackThemeSortColumn };

export type CountFeedbackThemesDALRequest = Pick<FeedbackTheme, "companyId">;

// DEV_NOTE: One theme by its public id within the company. isForUpdate locks the theme only.
export type GetFeedbackThemeDALRequest = Pick<FeedbackTheme, "companyId" | "publicId"> & {
  isForUpdate: boolean;
};

export type GetFeedbackThemeNotesDALRequest = Pick<FeedbackTheme, "companyId"> & {
  themeId: string;
  limit: number;
};

// DEV_NOTE: Open → Resolved or Dismissed. isNotFound when no Open theme has that id.
export type CloseFeedbackThemeDALRequest = Pick<FeedbackTheme, "companyId" | "id"> & {
  status: FeedbackThemeStatusIntEnum.Resolved | FeedbackThemeStatusIntEnum.Dismissed;
};

export interface CloseFeedbackThemeQualityIssueRequest {
  companyId: string;
  feedbackThemeId: string;
  status: QualityIssueCloseStatus;
  adminId: string;
  actor: AuditActor;
}
