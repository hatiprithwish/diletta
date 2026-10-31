import type { PageDALRequest } from "../common";
import type {
  QualityIssue,
  QualityIssueCloseStatus,
  QualityIssueListTabEnum,
  QualityIssueSortColumn,
  QualityIssueStatusIntEnum,
} from "./QualityIssuesCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// A system issue (source = System) opens with no feedbackId, createdBy or evalCaseId: the CHECKs on the table
// reject anything else for that source. The DAL generates publicId. On a conversation (a model key failure, M2-3) it
// checks the conversation exists and takes its chatbot; chatbot-wide (a health drop, M5-5) it checks the chatbot.
export type CreateSystemQualityIssueDALRequest = Pick<
  QualityIssue,
  "companyId" | "issueType" | "note"
> &
  ({ conversationId: string; chatbotId?: undefined } | { conversationId: null; chatbotId: string });

// Params to find the company's open system issue of one type, and to serialise the writers that open one. chatbotId
// set = that chatbot's only (one open Health drop issue per chatbot, M5-5); absent = the company's (Model error).
export type FindOpenSystemQualityIssueDALRequest = Pick<QualityIssue, "companyId"> & {
  issueType: NonNullable<QualityIssue["issueType"]>;
  chatbotId?: string;
};

// Params to replace a quality issue's note, found by its public ID within one company
export type UpdateQualityIssueNoteDALRequest = Pick<QualityIssue, "companyId" | "publicId"> & {
  note: string;
};

// DEV_NOTE: A user issue (source = User, M2-8) opens from a thumbs-down, one per feedback row (UNQ_quality_issues_
// feedback_id): status Open, issueType null until triage, no note. The DAL generates publicId and checks the
// conversation exists in the company and the feedback row rates a message of that very conversation.
export type CreateUserQualityIssueDALRequest = Pick<QualityIssue, "companyId"> & {
  conversationId: string;
  feedbackId: string;
};

// DEV_NOTE: Open issues now (Overview's needs attention, M4-3). chatbotId set = only that chatbot's; null = the whole
// company.
export type CountOpenQualityIssuesDALRequest = Pick<QualityIssue, "companyId"> & {
  chatbotId: string | null;
};

// DEV_NOTE: An admin's flag on a conversation (M4-4, source = Admin): status Open, issueType null until triage, no
// note. At most one open admin issue per conversation: the DAL locks (company, conversation) and returns the open one
// instead of opening another. It checks the conversation and the admin exist in the company.
export type CreateAdminQualityIssueDALRequest = Pick<QualityIssue, "companyId"> & {
  conversationId: string;
  createdBy: string;
};

// DEV_NOTE: The Quality list's filters (M4-6), resolved by the Repo: chatbotId is the internal id of the chatbot public
// id the client sent (the issue's chatbot_id), null = the whole company
export type QualityIssuesFilterDALRequest = Pick<QualityIssue, "companyId"> & {
  tab: QualityIssueListTabEnum;
  chatbotId: string | null;
};

// DEV_NOTE: Every tab's count is read at once, so the count takes the filters but the tab
export type CountDashboardQualityIssuesDALRequest = Omit<QualityIssuesFilterDALRequest, "tab">;

export type GetDashboardQualityIssuesDALRequest = QualityIssuesFilterDALRequest &
  PageDALRequest & { sortColumn: QualityIssueSortColumn };

// DEV_NOTE: One issue by its public id within the company. isForUpdate (every write, M4-6) locks the issue row only.
export type FindDashboardQualityIssueDALRequest = Pick<QualityIssue, "companyId" | "publicId"> & {
  isForUpdate?: boolean;
};

// DEV_NOTE: Triage (M4-6): an absent field keeps its value, null clears it. Only an Open issue changes (the DAL matches
// status Open); updatedBy = the admin. note is free text, never logged.
export type TriageQualityIssueDALRequest = Pick<QualityIssue, "companyId" | "id"> & {
  issueType?: QualityIssue["issueType"];
  note?: QualityIssue["note"];
  updatedBy: string;
};

// DEV_NOTE: Open → Fixed / Dismissed (evalCaseId null) or Converted (evalCaseId = the test made from it): the DAL matches
// status Open, and CHK_quality_issues_converted_eval_case_id ties evalCaseId to Converted
export type UpdateQualityIssueStatusDALRequest = Pick<QualityIssue, "companyId" | "id"> &
  (
    | { status: QualityIssueCloseStatus; evalCaseId: null }
    | { status: QualityIssueStatusIntEnum.Converted; evalCaseId: string }
  ) & {
    updatedBy: string;
  };
