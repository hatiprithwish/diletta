import type { FeedbackRatingIntEnum } from "../feedback";
import type { QualityIssue, QualityIssueTabCounts } from "./QualityIssuesCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface QualityIssueDALResponse extends ApiResponse {
  qualityIssue?: QualityIssue;
}

// DEV_NOTE: A write that opens an issue or returns the one already open. On success isCreated is always set: true =
// opened now, false = an existing issue returned as it is
export interface QualityIssueWriteDALResponse extends QualityIssueDALResponse {
  isCreated?: boolean;
}

// DEV_NOTE: isCreated false = the feedback row already had its issue (a visitor rating Down again)
export type UserQualityIssueDALResponse = QualityIssueWriteDALResponse;

// Open issues, and how many of them came from users (a thumbs-down)
export interface OpenQualityIssueCountsDALResponse extends ApiResponse {
  totalCount?: number;
  userCount?: number;
}

// DEV_NOTE: isCreated false = the conversation already had an open admin issue
export type AdminQualityIssueDALResponse = QualityIssueWriteDALResponse;

// DEV_NOTE: One issue as the Quality page reads it (M4-6), with internal ids (the Repo drops them). The conversation is
// an inner join; the issue's change request, test and rated reply are left joins (no DB foreign keys). ratedReplyText
// is the start of the rated reply's text (QUALITY_ISSUE_EXCERPT_MAX_CHARS + 1 chars, so a longer one can be marked
// cut; null once purged). rating = the rating as it stands now (the user may have switched it to Up).
export interface DashboardQualityIssueRow {
  id: string;
  publicId: string;
  conversationId: string;
  conversationRootLogId: string | null;
  chatbotId: string;
  source: QualityIssue["source"];
  status: QualityIssue["status"];
  issueType: QualityIssue["issueType"];
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  conversationPublicId: string;
  conversationTitle: string | null;
  conversationContentPurgedAt: Date | null;
  chatbotName: string | null;
  userName: string | null;
  changeRequestPublicId: string | null;
  evalCasePublicId: string | null;
  evalCaseName: string | null;
  ratedMessageId: string | null;
  ratedReplyText: string | null;
  rating: FeedbackRatingIntEnum | null;
}

export interface DashboardQualityIssueDALResponse extends ApiResponse {
  qualityIssue?: DashboardQualityIssueRow;
}

export interface DashboardQualityIssuesDALResponse extends ApiResponse {
  qualityIssues?: DashboardQualityIssueRow[];
}

// DEV_NOTE: Every tab's count; totalRecords = all of them
export interface QualityIssueTabCountsDALResponse extends TotalRecordsResponse {
  tabCounts?: QualityIssueTabCounts;
}
