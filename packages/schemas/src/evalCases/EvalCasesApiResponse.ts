import type { ApiResponse } from "../common";
import type { EvalCaseBody, EvalCaseUpdateFailureEnum } from "./EvalCasesCommon";

// DEV_NOTE: One case on the Tests page (M4-8). isPlatform = the platform's own case (read-only, runs against every
// chatbot; chatbotName null). latestResult = the newest run it was part of: hasPassed = every attempt passed; null =
// never run.
export interface EvalCaseListItem {
  publicId: string;
  name: string;
  isSafety: boolean;
  isActive: boolean;
  isPlatform: boolean;
  chatbotName: string | null;
  latestResult: {
    evalRunPublicId: string;
    hasPassed: boolean;
    attemptCount: number;
    passedAttemptCount: number;
    createdAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

// DEV_NOTE: GET /dashboard/eval-cases/:publicId: the list item with its conversation and rubric (body null = a shape
// the page can't show or edit, readEvalCaseBody)
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

// DEV_NOTE: POST and PATCH: the case as it stands after. failure set (409) = the edit was refused (NotEditable)
export interface WriteEvalCaseApiResponse extends ApiResponse {
  evalCase?: EvalCaseDetail;
  failure?: EvalCaseUpdateFailureEnum;
}
