import type { ApiResponse } from "../common";
import type { FeedbackRatingIntEnum } from "../feedback";
import type { MessageRoleIntEnum } from "../messages";
import type {
  QualityIssueSourceIntEnum,
  QualityIssueSourceLabelEnum,
  QualityIssueStatusIntEnum,
  QualityIssueStatusLabelEnum,
  QualityIssueTabCounts,
  QualityIssueTypeIntEnum,
  QualityIssueTypeLabelEnum,
  QualityIssueUpdateFailureEnum,
  QualityTestDraft,
  QualityTestDraftFailureEnum,
} from "./QualityIssuesCommon";

// DEV_NOTE: One row of the Quality list (M4-6). Status Enum Pattern for source, status and type (issueType null = not
// triaged yet). ratedReply = the start of the reply a user rated down (user issues; null for the others and once the
// chat is purged). conversation null = a chatbot-wide system issue (a health drop, M5-5); its title null = purged or
// none. chatbotName = the chatbot the issue is about (null once it is removed).
export interface QualityIssueListItem {
  publicId: string;
  source: QualityIssueSourceIntEnum;
  sourceLabel: QualityIssueSourceLabelEnum;
  qualityIssueStatus: QualityIssueStatusIntEnum;
  qualityIssueStatusLabel: QualityIssueStatusLabelEnum;
  issueType: QualityIssueTypeIntEnum | null;
  issueTypeLabel: QualityIssueTypeLabelEnum | null;
  note: string | null;
  ratedReply: string | null;
  chatbotName: string | null;
  conversation: {
    publicId: string;
    title: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

// DEV_NOTE: One message of the issue's excerpt: the question and the reply it is about (the rated reply's turn for a
// user issue, the conversation's last answered turn otherwise)
export interface QualityIssueExcerptMessage {
  role: MessageRoleIntEnum;
  text: string;
}

// DEV_NOTE: GET /dashboard/quality-issues/:publicId. rating = the user's rating now (they may have switched it to Up);
// excerpt is empty once the chat is purged (isContentPurged) or before it has any text. changeRequestPublicId opens the change the issue is about; evalCase = the
// test it became (Converted).
export interface QualityIssueDetail extends Omit<QualityIssueListItem, "conversation"> {
  rating: FeedbackRatingIntEnum | null;
  excerpt: QualityIssueExcerptMessage[];
  isContentPurged: boolean;
  conversation: {
    publicId: string;
    title: string | null;
    chatbotName: string | null;
    userName: string | null;
  } | null;
  changeRequestPublicId: string | null;
  evalCase: { publicId: string; name: string } | null;
}

export interface GetQualityIssuesApiResponse extends ApiResponse {
  qualityIssues?: QualityIssueListItem[];
  totalRecords?: number;
  tabCounts?: QualityIssueTabCounts;
}

export interface GetQualityIssueApiResponse extends ApiResponse {
  qualityIssue?: QualityIssueDetail;
}

// DEV_NOTE: GET /dashboard/quality-issues/open-count: the sidebar's Quality badge (DESIGN.md §4)
export interface GetQualityIssuesOpenCountApiResponse extends ApiResponse {
  openCount?: number;
}

// DEV_NOTE: PATCH …/:publicId, POST …/fix, …/dismiss, …/convert: the issue as it stands after. failure set (409) = it
// is no longer Open
export interface UpdateQualityIssueApiResponse extends ApiResponse {
  qualityIssue?: QualityIssueDetail;
  failure?: QualityIssueUpdateFailureEnum;
}

// DEV_NOTE: POST …/:publicId/test-draft: the rewritten chat to review, saved nowhere. failure says why there is none
// (QUALITY_TEST_DRAFT_FAILURE_HTTP_STATUS_MAP).
export interface DraftQualityTestApiResponse extends ApiResponse {
  draft?: QualityTestDraft;
  failure?: QualityTestDraftFailureEnum;
}
