import type { QualityIssue } from "./QualityIssuesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface QualityIssueDALResponse extends ApiResponse {
  qualityIssue?: QualityIssue;
}

// DEV_NOTE: On success isCreated is always set: true = opened now, false = the feedback row already had its issue (a
// visitor rating Down again), returned as it is
export interface UserQualityIssueDALResponse extends QualityIssueDALResponse {
  isCreated?: boolean;
}

// Open issues, and how many of them came from users (a thumbs-down)
export interface OpenQualityIssueCountsDALResponse extends ApiResponse {
  totalCount?: number;
  userCount?: number;
}

// DEV_NOTE: On success isCreated is always set: true = opened now, false = the conversation already had an open admin
// issue, returned as it is
export type AdminQualityIssueDALResponse = UserQualityIssueDALResponse;
