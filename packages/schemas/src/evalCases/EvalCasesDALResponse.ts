import type { ApiResponse } from "../common";
import type { EvalCase } from "./EvalCasesCommon";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface EvalCaseDALResponse extends ApiResponse {
  evalCase?: EvalCase;
}
