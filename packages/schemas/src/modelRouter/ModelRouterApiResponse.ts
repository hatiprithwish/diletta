import type { ApiResponse } from "../common";
import type { ModelRouterFailureEnum } from "./ModelRouterCommon";

// DEV_NOTE: Server-side only. TModel is the AI SDK LanguageModel, which @app/schemas doesn't depend on, so the
// backend fills it in. isSuccess false always comes with a failure, which the caller shows as
// MODEL_UNAVAILABLE_MESSAGE.
export interface GetModelResponse<TModel> extends ApiResponse {
  model?: TModel;
  failure?: ModelRouterFailureEnum;
}

// DEV_NOTE: Server-side only (ModelRouterRepo key lookup). secret is the decrypted company model key: it goes to
// the gateway provider and nowhere else (never a log, a response body or storage).
export interface DecryptedModelKeyResponse extends ApiResponse {
  secret?: string;
  companySecretPublicId?: string;
}

// DEV_NOTE: Server-side only (ModelRouterRepo key-failure path). qualityIssueId and outboxId are set when this
// failure opened the company's system issue; they stay unset when one was already open or the call had no
// conversation. outboxId is relayed after the commit.
export interface HandleModelKeyFailureResponse extends ApiResponse {
  qualityIssueId?: string;
  outboxId?: string;
}
