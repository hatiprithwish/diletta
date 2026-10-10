import type { QualityIssue } from "./QualityIssuesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// A system issue (source = System) opens with no feedbackId, createdBy or evalCaseId: the CHECKs on the table
// reject anything else for that source. The DAL generates publicId and checks the conversation exists.
export type CreateSystemQualityIssueDALRequest = Pick<
  QualityIssue,
  "companyId" | "conversationId" | "issueType" | "note"
>;

// Params to find the company's open system issue of one type, and to serialise the writers that open one
export type FindOpenSystemQualityIssueDALRequest = Pick<QualityIssue, "companyId"> & {
  issueType: NonNullable<QualityIssue["issueType"]>;
};

// Params to replace a quality issue's note, found by its public ID within one company
export type UpdateQualityIssueNoteDALRequest = Pick<QualityIssue, "companyId" | "publicId"> & {
  note: string;
};

// DEV_NOTE: A user issue (source = User, M2-8) opens from a thumbs-down, one per feedback row (UNQ_quality_issues_
// feedback_id): status Open, issueType null until triage, no note. The DAL generates publicId and checks the
// conversation exists in the company and the feedback row rates a message of that very conversation.
export type CreateUserQualityIssueDALRequest = Pick<
  QualityIssue,
  "companyId" | "conversationId"
> & {
  feedbackId: string;
};
