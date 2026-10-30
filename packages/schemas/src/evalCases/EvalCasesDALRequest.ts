import type { PageDALRequest } from "../common";
import type {
  EvalCase,
  EvalCaseExpectations,
  EvalCaseInputV1,
  EvalCaseSortColumn,
} from "./EvalCasesCommon";
import type { PlatformEvalCase } from "./PlatformEvalCases";

// DEV_NOTE: A customer case (M4-6, from a quality issue): always one company's and one chatbot's, never a safety case,
// active. The DAL generates publicId and checks the chatbot exists in the company.
export type CreateEvalCaseDALRequest = Pick<EvalCase, "name"> & {
  companyId: string;
  chatbotId: string;
  input: EvalCaseInputV1;
  expectations: EvalCaseExpectations;
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
// bodies at the current version (the Repo merges the edit into the stored one, read through its upgrader).
export type UpdateEvalCaseDALRequest = Pick<EvalCase, "id"> & {
  companyId: string;
  name?: string;
  input?: EvalCaseInputV1;
  expectations?: EvalCaseExpectations;
  isActive?: boolean;
};

// DEV_NOTE: The newest run each of these cases was part of, for the Cases tab. chatbotId set = only runs of that
// chatbot's configs (a platform case runs against every chatbot); null = any of the company's runs.
export type GetLatestEvalCaseResultsDALRequest = {
  companyId: string;
  chatbotId: string | null;
  evalCaseIds: string[];
};

// DEV_NOTE: The active cases that run against one chatbot: its own and the platform's (the summary's counts)
export type CountActiveEvalCasesDALRequest = { companyId: string; chatbotId: string };

// DEV_NOTE: The cases an eval run of one chatbot runs (M5-2): its active cases and every active platform case, at most
// limit. isSafetyOnly: only its safety cases (the publish gate's check that the approved run ran them all, M5-4).
export type GetRunnableEvalCasesDALRequest = {
  companyId: string;
  chatbotId: string;
  limit: number;
  isSafetyOnly?: boolean;
};

// DEV_NOTE: The platform suite's sync (M5-5), in withPlatform: a new keyed platform case (company and chatbot null), and
// an existing one by its id rewritten to the case in code, turned on again. The DAL generates publicId on insert.
export type CreatePlatformEvalCaseDALRequest = PlatformEvalCase;
export type UpdatePlatformEvalCaseDALRequest = PlatformEvalCase & Pick<EvalCase, "id">;

// DEV_NOTE: Keyed platform cases no longer in code, turned off. Safety ones are left alone (the CHECK keeps a platform
// safety case active); the Repo never sends one.
export type DeactivatePlatformEvalCasesDALRequest = { ids: string[] };
