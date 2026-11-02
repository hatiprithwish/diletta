import type { ApiResponse, TotalRecordsResponse } from "../common";
import type { EvalRunStatusIntEnum } from "../evalRuns";
import type { EvalCase } from "./EvalCasesCommon";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface EvalCaseDALResponse extends ApiResponse {
  evalCase?: EvalCase;
}

// DEV_NOTE: A case as the Tests page reads it (M4-8), with its chatbot's name (left join; null for a platform case or a
// removed chatbot)
export interface DashboardEvalCaseRow extends EvalCase {
  chatbotName: string | null;
}

export interface DashboardEvalCaseDALResponse extends ApiResponse {
  evalCase?: DashboardEvalCaseRow;
}

export interface DashboardEvalCasesDALResponse extends ApiResponse {
  evalCases?: DashboardEvalCaseRow[];
}

export type EvalCasesCountDALResponse = TotalRecordsResponse;

// DEV_NOTE: A case's newest run (the highest eval_run_id among its results) and how its attempts went in it
export interface LatestEvalCaseResult {
  evalCaseId: string;
  evalRunPublicId: string;
  evalRunStatus: EvalRunStatusIntEnum;
  k: number;
  attemptCount: number;
  passedAttemptCount: number;
  createdAt: Date;
}

export interface LatestEvalCaseResultsDALResponse extends ApiResponse {
  results?: LatestEvalCaseResult[];
}

export interface ActiveEvalCaseCountsDALResponse extends ApiResponse {
  caseCount?: number;
  safetyCaseCount?: number;
}

export interface EvalCasesDALResponse extends ApiResponse {
  evalCases?: EvalCase[];
}

// DEV_NOTE: How many keyed platform cases a sync step changed
export interface PlatformEvalCasesWriteDALResponse extends ApiResponse {
  changedCount?: number;
}
