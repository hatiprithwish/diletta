import type { ApiResponse, TotalRecordsResponse } from "../common";
import type { ChatbotConfigStatusIntEnum } from "../chatbotConfigs";
import type { EvalRun } from "./EvalRunsCommon";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.

// DEV_NOTE: A run as the Tests page reads it (M4-8): the run, with its config (inner join: a config is archived, never
// deleted) and the config's chatbot's name (left join: a removed chatbot leaves its runs)
export interface DashboardEvalRunRow extends EvalRun {
  configPublicId: string;
  configVersion: number;
  configStatus: ChatbotConfigStatusIntEnum;
  chatbotName: string | null;
}

export interface DashboardEvalRunDALResponse extends ApiResponse {
  evalRun?: DashboardEvalRunRow;
}

export interface DashboardEvalRunsDALResponse extends ApiResponse {
  evalRuns?: DashboardEvalRunRow[];
}

export type EvalRunsCountDALResponse = TotalRecordsResponse;

// DEV_NOTE: One safety case of a run: how many of its attempts ran and passed
export interface EvalRunSafetyCaseRow {
  evalRunId: string;
  attemptCount: number;
  passedAttemptCount: number;
}

export interface EvalRunSafetyCasesDALResponse extends ApiResponse {
  safetyCases?: EvalRunSafetyCaseRow[];
}

// DEV_NOTE: One case of a run, grouped from its results. caseCompanyId null = a platform case.
export interface EvalRunCaseRow {
  evalCasePublicId: string;
  name: string;
  isSafety: boolean;
  caseCompanyId: string | null;
  attemptCount: number;
  passedAttemptCount: number;
}

export interface EvalRunCasesDALResponse extends ApiResponse {
  cases?: EvalRunCaseRow[];
}

// DEV_NOTE: One attempt of a case in a run, with its case (repeated on every row) and its transcript file's public id
// (left join: null when the harness stored none, or the file was purged). graderOutput is raw jsonb.
export interface EvalRunCaseAttemptRow extends Omit<
  EvalRunCaseRow,
  "attemptCount" | "passedAttemptCount"
> {
  attempt: number;
  hasPassed: boolean;
  graderOutput: unknown;
  latencyMs: number | null;
  transcriptFilePublicId: string | null;
  createdAt: Date;
}

// DEV_NOTE: isNotFound when the case has no result in the run, so on success there is always a first attempt
export interface EvalRunCaseAttemptsDALResponse extends ApiResponse {
  attempts?: [EvalRunCaseAttemptRow, ...EvalRunCaseAttemptRow[]];
}

// DEV_NOTE: chatbotConfigId is internal (the Repo matches it to its versions)
export interface LatestEvalRunsByConfigDALResponse extends ApiResponse {
  runs?: Pick<EvalRun, "id" | "publicId" | "chatbotConfigId" | "k" | "status" | "hasPassed">[];
}

// ─── The eval harness's writes (M5-2) ───────────────────────────────────────

export interface EvalRunDALResponse extends ApiResponse {
  evalRun?: EvalRun;
}

// DEV_NOTE: isConflict = the attempt already has a result. evalResultId = the new row's (its transcript's owner)
export interface CreateEvalResultDALResponse extends ApiResponse {
  isConflict?: boolean;
  evalResultId?: string;
}

export interface HasEvalResultDALResponse extends ApiResponse {
  hasResult?: boolean;
}

// DEV_NOTE: One case's attempts in a run: how many were recorded and how many passed, and whether it is a safety case
// (the gate's hard rule, M5-4)
export interface EvalRunCaseTallyRow {
  evalCaseId: string;
  isSafety: boolean;
  attemptCount: number;
  passedAttemptCount: number;
}

export interface EvalRunTalliesDALResponse extends ApiResponse {
  tallies?: EvalRunCaseTallyRow[];
}
