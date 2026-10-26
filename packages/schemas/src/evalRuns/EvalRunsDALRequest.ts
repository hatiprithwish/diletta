import type { PageDALRequest } from "../common";
import type { EvalRun, EvalRunCaseSortColumn, EvalRunSortColumn } from "./EvalRunsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. The Tests page
// (M4-8) only reads runs; the eval harness (M5-2) writes them.

// DEV_NOTE: The runs list's filter, resolved by the Repo: chatbotId = the internal id of the botId the client sent
// (through the run's config), null = the whole company
export type EvalRunsFilterDALRequest = Pick<EvalRun, "companyId"> & { chatbotId: string | null };

export type GetEvalRunsDALRequest = EvalRunsFilterDALRequest &
  PageDALRequest & { sortColumn: EvalRunSortColumn };

export type FindEvalRunDALRequest = Pick<EvalRun, "companyId" | "publicId">;

export type FindEvalRunByIdDALRequest = Pick<EvalRun, "companyId" | "id">;

// DEV_NOTE: A config's newest run (the summary's live and draft cards)
export type FindLatestEvalRunDALRequest = Pick<EvalRun, "companyId" | "chatbotConfigId">;

// DEV_NOTE: Each of these configs' newest run in one read (Settings › Bots' Tests column, M4-10)
export type GetLatestEvalRunsByConfigDALRequest = Pick<EvalRun, "companyId"> & {
  chatbotConfigIds: string[];
};

// DEV_NOTE: The safety cases of a page of runs, read in one query (the Repo tallies them against each run's k)
export type GetEvalRunSafetyCasesDALRequest = Pick<EvalRun, "companyId"> & { evalRunIds: string[] };

// DEV_NOTE: One run's cases, grouped from its results. k and isRunUnderway place each case for the Result sort (failed,
// still running, passed), the same three states as evalCaseRunResult.
export type GetEvalRunCasesDALRequest = Pick<EvalRun, "companyId" | "k"> &
  PageDALRequest & {
    evalRunId: string;
    isRunUnderway: boolean;
    sortColumn: EvalRunCaseSortColumn;
  };

export type CountEvalRunCasesDALRequest = Pick<EvalRun, "companyId"> & { evalRunId: string };

// DEV_NOTE: One case's attempts in one run, the case found by its public id (the company's own or a platform case)
export type GetEvalRunCaseAttemptsDALRequest = Pick<EvalRun, "companyId"> & {
  evalRunId: string;
  evalCasePublicId: string;
};
