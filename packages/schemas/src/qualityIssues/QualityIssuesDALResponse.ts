import type { QualityIssue } from "./QualityIssuesCommon";
import type { ApiResponse } from "../common";

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
