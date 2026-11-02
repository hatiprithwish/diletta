import type { ApiResponse } from "../common";
import type { ChatbotConfigStatusIntEnum, ChatbotConfigStatusLabelEnum } from "../chatbotConfigs";
import type {
  EvalRunFailureIntEnum,
  EvalRunFailureLabelEnum,
  EvalRunStatusIntEnum,
  EvalRunStatusLabelEnum,
  EvalRunTriggerIntEnum,
  EvalRunTriggerLabelEnum,
} from "./EvalRunsCommon";

// DEV_NOTE: One run on the Tests page (M4-8). Status Enum Pattern for trigger, status and the config's status.
// caseCount / passAllKCount / hasPassed are null until the run is Done. safety counts the run's safety cases and those
// that passed every attempt (a failed one blocks publishing, M5-4). costUsd is an exact decimal string. failure = why the
// harness stopped a Failed run (M5-3), null when it didn't say (the page then says "Didn't finish").
export interface EvalRunListItem {
  publicId: string;
  trigger: EvalRunTriggerIntEnum;
  triggerLabel: EvalRunTriggerLabelEnum;
  evalRunStatus: EvalRunStatusIntEnum;
  evalRunStatusLabel: EvalRunStatusLabelEnum;
  config: {
    publicId: string;
    configVersion: number;
    chatbotConfigStatus: ChatbotConfigStatusIntEnum;
    chatbotConfigStatusLabel: ChatbotConfigStatusLabelEnum;
    chatbotName: string | null;
  };
  k: number;
  caseCount: number | null;
  passAllKCount: number | null;
  safety: { passedCount: number; totalCount: number };
  hasPassed: boolean | null;
  failure: EvalRunFailureIntEnum | null;
  failureLabel: EvalRunFailureLabelEnum | null;
  costUsd: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface GetEvalRunsApiResponse extends ApiResponse {
  evalRuns?: EvalRunListItem[];
  totalRecords?: number;
}

export interface GetEvalRunApiResponse extends ApiResponse {
  evalRun?: EvalRunListItem;
}

// DEV_NOTE: A config's latest test result for the metric strip: the live one's gate run (approved_by_run_id), else its
// newest run; a draft's newest run. run null = never tested.
export interface EvalRunsSummaryConfig {
  configVersion: number;
  run: EvalRunListItem | null;
}

// DEV_NOTE: GET /dashboard/eval-runs/summary. chatbot = the one shown (botId's, else the default; null = the company has
// none). Case counts are the active cases that run against it: its own and the platform's. live null = nothing
// published; draft null = no config being worked on. staging = the host the tests run against (an active staging
// connection's base URL host); null = none set up.
export interface EvalRunsSummary {
  chatbot: { publicId: string; name: string } | null;
  caseCount: number;
  safetyCaseCount: number;
  live: EvalRunsSummaryConfig | null;
  draft: EvalRunsSummaryConfig | null;
  staging: { host: string } | null;
}

export interface GetEvalRunsSummaryApiResponse extends ApiResponse {
  summary?: EvalRunsSummary;
}

// DEV_NOTE: One case of a run: how many of its attempts ran and passed. isPlatform = one of the platform's own cases
// (read-only for a company). hasPassed = evalCaseRunResult: null while the run is still grading it.
export interface EvalRunCaseItem {
  evalCase: {
    publicId: string;
    name: string;
    isSafety: boolean;
    isPlatform: boolean;
  };
  attemptCount: number;
  passedAttemptCount: number;
  hasPassed: boolean | null;
}

export interface GetEvalRunCasesApiResponse extends ApiResponse {
  cases?: EvalRunCaseItem[];
  totalRecords?: number;
}

// DEV_NOTE: The nightly platform suite's missed-run check (M5-5). isChecked false = this env has no suite company
// (NIGHTLY_SUITE_COMPANY_ID unset). isOverdue = no Nightly run of that company reached Done within
// NIGHTLY_SUITE_MAX_AGE_MS; lastFinishedAt = the newest one's finish, null when it has none.
export interface CheckNightlySuiteResponse extends ApiResponse {
  isChecked?: boolean;
  isOverdue?: boolean;
  lastFinishedAt?: Date | null;
}
