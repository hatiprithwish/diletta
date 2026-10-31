import type { ApiResponse } from "../common";
import type { EvalCaseBody, EvalCaseUpdateFailureEnum } from "./EvalCasesCommon";

// DEV_NOTE: One case on the Tests page (M4-8). isPlatform = the platform's own case (read-only, runs against every
// chatbot; chatbotName null). latestResult = the newest run it was part of (the botId chatbot's runs when filtered):
// hasPassed = evalCaseRunResult, null while that run is still grading it; latestResult null = never run.
export interface EvalCaseListItem {
  publicId: string;
  name: string;
  isSafety: boolean;
  isActive: boolean;
  isPlatform: boolean;
  chatbotName: string | null;
  latestResult: {
    evalRunPublicId: string;
    hasPassed: boolean | null;
    attemptCount: number;
    passedAttemptCount: number;
    createdAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

// DEV_NOTE: GET /dashboard/eval-cases/:publicId: the list item with its conversation, rubric and other checks. body null = a platform
// case (its prompts and pass criteria gate publishing, so a company never sees them) or a shape the page can't show or
// edit (readEvalCaseBody).
export interface EvalCaseDetail extends EvalCaseListItem {
  body: EvalCaseBody | null;
}

export interface GetEvalCasesApiResponse extends ApiResponse {
  evalCases?: EvalCaseListItem[];
  totalRecords?: number;
}

export interface GetEvalCaseApiResponse extends ApiResponse {
  evalCase?: EvalCaseDetail;
}

// DEV_NOTE: POST and PATCH: the case as it stands after. failure set = the edit was refused (EvalCaseUpdateFailureEnum, status from
// EVAL_CASE_UPDATE_FAILURE_HTTP_STATUS_MAP)
export interface WriteEvalCaseApiResponse extends ApiResponse {
  evalCase?: EvalCaseDetail;
  failure?: EvalCaseUpdateFailureEnum;
}

// DEV_NOTE: What a platform suite sync did (M5-5): cases inserted, rewritten, turned off, and the keys of safety cases
// code removed or demoted that it left as they are (a platform safety case can't be retired by code; it alerts instead)
export interface SyncPlatformEvalCasesResponse extends ApiResponse {
  createdCount?: number;
  updatedCount?: number;
  deactivatedCount?: number;
  keptSafetyKeys?: string[];
}
