import type { ApiResponse } from "../common";
import type { RuntimeTool } from "../toolCalls";
import type {
  ChangeRequestFailureEnum,
  ChangeRequestPayload,
  WidgetChangeRequest,
} from "./ChangeRequestsCommon";

// DEV_NOTE: Server-side only (ActionEngineRepo → Conversation DO). changeRequest is the widget's view (decrypted
// values: it goes to the user's own widget only). outboxIds (internal) are the events to relay after the commit.
// failure says why a step was refused.
export interface ChangeRequestStepResponse extends ApiResponse {
  changeRequest?: WidgetChangeRequest;
  outboxIds?: string[];
  failure?: ChangeRequestFailureEnum;
}

export interface RecordToolCallResponse extends ApiResponse {
  outboxIds?: string[];
}

// DEV_NOTE: What a commit sends: the tool as stored for this change request (its version, re-checked Active), the
// decrypted payload, the change request's commit key, and isResume when an earlier attempt may have reached the host
// (it was already Committing: an eviction mid-commit)
export interface CommitPlan {
  changeRequestPublicId: string;
  tool: RuntimeTool;
  payload: ChangeRequestPayload;
  idempotencyKey: string;
  isResume: boolean;
}

export interface StartCommitResponse extends ChangeRequestStepResponse {
  plan?: CommitPlan;
}

export interface ChangeRequestViewsResponse extends ApiResponse {
  changeRequests?: WidgetChangeRequest[];
}

// DEV_NOTE: The turn's tools, and how many pins were left out (Disabled, Draft or missing version, connection not
// Active, ops that don't load, an input_schema that can't be checked: each logged)
export interface LoadTurnToolsResponse extends ApiResponse {
  tools?: RuntimeTool[];
  skippedCount?: number;
}

// DEV_NOTE: Server-side only (inside ActionEngineRepo) — the conversation, company and chatbot as a step finds them
// (rootLogId parents the step's event), or why the step can't go on
export type ChangeRequestConversationCheck =
  | { isSuccess: true; rootLogId: string | null; isReadOnly: boolean }
  | { isSuccess: false; failure: ChangeRequestFailureEnum; message?: string };
