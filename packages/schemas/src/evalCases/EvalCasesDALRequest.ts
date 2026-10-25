import type { PageDALRequest } from "../common";
import type {
  EvalCase,
  EvalCaseExpectationsV1,
  EvalCaseInputV1,
  EvalCaseSortColumn,
} from "./EvalCasesCommon";

// DEV_NOTE: A customer case (M4-6, from a quality issue): always one company's and one chatbot's, never a safety case,
// active. The DAL generates publicId and checks the chatbot exists in the company.
export type CreateEvalCaseDALRequest = Pick<EvalCase, "name"> & {
  companyId: string;
  chatbotId: string;
  input: EvalCaseInputV1;
  expectations: EvalCaseExpectationsV1;
};

// DEV_NOTE: The Cases tab's filter (M4-8), resolved by the Repo: chatbotId = the internal id of the botId the client
// sent, null = every chatbot's. Platform cases (company_id null) are always in.
export type EvalCasesFilterDALRequest = { companyId: string; chatbotId: string | null };

export type GetEvalCasesDALRequest = EvalCasesFilterDALRequest &
  PageDALRequest & { sortColumn: EvalCaseSortColumn };

// DEV_NOTE: One case by its public id: the company's own or a platform case. isForUpdate (an edit) finds the company's
// own only and locks it.
export type FindEvalCaseDALRequest = Pick<EvalCase, "publicId"> & {
  companyId: string;
  isForUpdate?: boolean;
};

// DEV_NOTE: An edit of the company's own case (M4-8): an absent field keeps its value. input / expectations are whole
// v1 bodies (the Repo merges the edit into the stored one).
export type UpdateEvalCaseDALRequest = Pick<EvalCase, "id"> & {
  companyId: string;
  name?: string;
  input?: EvalCaseInputV1;
  expectations?: EvalCaseExpectationsV1;
  isActive?: boolean;
};

// DEV_NOTE: The newest run each of these cases was part of, for the Cases tab
export type GetLatestEvalCaseResultsDALRequest = { companyId: string; evalCaseIds: string[] };

// DEV_NOTE: The active cases that run against one chatbot: its own and the platform's (the summary's counts)
export type CountActiveEvalCasesDALRequest = { companyId: string; chatbotId: string };
