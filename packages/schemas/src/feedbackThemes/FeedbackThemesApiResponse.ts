import type { ApiResponse } from "../common";
import type { FeedbackRatingIntEnum, FeedbackRatingLabelEnum } from "../feedback/FeedbackCommon";
import type {
  FeedbackThemeRatingCounts,
  FeedbackThemeStatusIntEnum,
  FeedbackThemeStatusLabelEnum,
  FeedbackThemeTabCounts,
  FeedbackThemeUpdateFailureEnum,
} from "./FeedbackThemesCommon";

// DEV_NOTE: One theme (M7-10). Status Enum Pattern for its status and thumb. label and latestSummary are model rewrites
// with no personal details. userCount = the different users behind its notes. qualityIssuePublicId = the Quality item it
// opened (a Didn't like theme at 5 notes from 3 users), null if none. chatbotName = null once the chatbot is removed.
export interface FeedbackThemeListItem {
  publicId: string;
  chatbotName: string | null;
  label: string;
  rating: FeedbackRatingIntEnum;
  ratingLabel: FeedbackRatingLabelEnum;
  feedbackThemeStatus: FeedbackThemeStatusIntEnum;
  feedbackThemeStatusLabel: FeedbackThemeStatusLabelEnum;
  noteCount: number;
  userCount: number;
  latestSummary: string | null;
  latestNoteAt: string | null;
  qualityIssuePublicId: string | null;
  createdAt: string;
  updatedAt: string;
}

// DEV_NOTE: tabCounts = each status's count for the chosen thumb; ratingCounts = each thumb's count in the chosen tab
export interface GetFeedbackThemesApiResponse extends ApiResponse {
  feedbackThemes?: FeedbackThemeListItem[];
  totalRecords?: number;
  tabCounts?: FeedbackThemeTabCounts;
  ratingCounts?: FeedbackThemeRatingCounts;
}

// DEV_NOTE: One note in a theme, as rewritten (no personal details); conversationPublicId opens its chat
export interface FeedbackThemeNoteItem {
  publicId: string;
  summary: string;
  conversationPublicId: string | null;
  createdAt: string;
}

// DEV_NOTE: GET /dashboard/feedback-themes/:publicId: the theme and its newest FEEDBACK_THEME_NOTES_MAX notes
export interface FeedbackThemeDetail extends FeedbackThemeListItem {
  notes: FeedbackThemeNoteItem[];
}

export interface GetFeedbackThemeApiResponse extends ApiResponse {
  feedbackTheme?: FeedbackThemeDetail;
}

// DEV_NOTE: POST …/resolve, …/dismiss: the theme as it stands after. failure set (409) = it is no longer Open
export interface UpdateFeedbackThemeApiResponse extends ApiResponse {
  feedbackTheme?: FeedbackThemeDetail;
  failure?: FeedbackThemeUpdateFailureEnum;
}
