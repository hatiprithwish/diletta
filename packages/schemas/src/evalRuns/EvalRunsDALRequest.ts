import type { PageDALRequest } from "../common";
import type {
  EvalRun,
  EvalRunCaseSortColumn,
  EvalRunSortColumn,
  EvalRunStatusIntEnum,
  EvalRunTriggerIntEnum,
} from "./EvalRunsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. The Tests page
// (M4-8) only reads runs; the eval harness (M5-2) writes them.

// DEV_NOTE: The runs list's filter, resolved by the Repo: chatbotId = the internal id of the botId the client sent
// (through the run's config), null = the whole company
export type EvalRunsFilterDALRequest = Pick<EvalRun, "companyId"> & { chatbotId: string | null };

export type GetEvalRunsDALRequest = EvalRunsFilterDALRequest &
  PageDALRequest & { sortColumn: EvalRunSortColumn };

// DEV_NOTE: isLocked = the run row under FOR UPDATE (the eval harness's steps): a result, an attempt start and the
// finish of one run take turns, so nothing is recorded into a run after it ended
export type FindEvalRunDALRequest = Pick<EvalRun, "companyId" | "publicId"> & {
  isLocked?: boolean;
};

export type FindEvalRunByIdDALRequest = Pick<EvalRun, "companyId" | "id">;

// DEV_NOTE: A config's newest run (the summary's live and draft cards)
export type FindLatestEvalRunDALRequest = Pick<EvalRun, "companyId" | "chatbotConfigId">;

// DEV_NOTE: Each of these configs' newest run in one read (Settings › Bots' Tests column, M4-10); trigger set = the newest
// run of that trigger only (a version's newest Gate run, M5-4)
export type GetLatestEvalRunsByConfigDALRequest = Pick<EvalRun, "companyId"> & {
  chatbotConfigIds: string[];
  trigger?: EvalRunTriggerIntEnum;
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

// ─── The eval harness's writes (M5-2) ───────────────────────────────────────

// DEV_NOTE: A run starts Running: the harness creates it as it starts driving the attempts, with its token's staging
// connection and the cases it hands out
export type CreateEvalRunDALRequest = Pick<
  EvalRun,
  "companyId" | "chatbotConfigId" | "trigger" | "harnessVersion" | "k"
> & { companyConnectionId: string; evalCaseIds: string[] };

// DEV_NOTE: A Running run ends (Done or Failed) once, with its tallies; a run that already ended is isNotFound. failure
// = why the harness stopped it (a Failed run only, else null)
export type FinishEvalRunDALRequest = Pick<
  EvalRun,
  "companyId" | "id" | "caseCount" | "passAllKCount" | "hasPassed" | "failure"
> & { status: EvalRunStatusIntEnum.Done | EvalRunStatusIntEnum.Failed };

// DEV_NOTE: The run's staging data was put back (or there was no reset_op to send): reset_at = now, only while Running
export type MarkEvalRunResetDALRequest = Pick<EvalRun, "companyId" | "id">;

// DEV_NOTE: A model call of the run changed its cost: cost_usd + addUsd - subtractUsd, in the database (exact decimals).
// A new call adds its cost; a backfilled one replaces the cost it was recorded with.
export type AddEvalRunCostDALRequest = Pick<EvalRun, "companyId" | "id"> & {
  addUsd: string;
  subtractUsd: string;
};

// DEV_NOTE: One graded attempt. A repeat of (run, case, attempt) is isConflict (append-only: never overwritten).
// transcriptFileId = its transcript's files row (M5-3), created just before it; null = the attempt never ran.
export type CreateEvalResultDALRequest = {
  companyId: string;
  evalRunId: string;
  evalCaseId: string;
  attempt: number;
  hasPassed: boolean;
  graderOutput: unknown;
  transcriptFileId: string | null;
  latencyMs: number | null;
};

// DEV_NOTE: Whether one attempt of a case of the run already has its result (the /results pre-check, M5-3)
export type HasEvalResultDALRequest = Pick<
  CreateEvalResultDALRequest,
  "companyId" | "evalRunId" | "evalCaseId" | "attempt"
>;

// DEV_NOTE: The attempt tally of every case of the run's set (the finish's pass^k and gate decision): one row per case,
// 0 attempts for one that never ran
export type GetEvalRunTalliesDALRequest = Pick<EvalRun, "companyId"> & {
  evalRunId: string;
  evalCaseIds: string[];
};

// DEV_NOTE: The company's newest Nightly run that reached Done (M5-5, the missed-suite check)
export type FindLatestDoneNightlyEvalRunDALRequest = Pick<EvalRun, "companyId">;
