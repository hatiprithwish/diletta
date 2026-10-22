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

// DEV_NOTE: What a landed commit needs next (M3-6): Verify = read the record back (readback_op with the args and the
// commit's result); Undo = the auto-undo of a Mismatch, or the user's undo of a Verified one (M3-7) (inverse_op under
// the change request's undo key, isResume when an earlier undo may have reached the host). tool: the change request's tool version, its ops read again by its id.
export enum ChangeRequestFollowUpEnum {
  Verify = "verify",
  Undo = "undo",
}

export interface FollowUpPlan {
  changeRequestPublicId: string;
  followUp: ChangeRequestFollowUpEnum;
  tool: RuntimeTool;
  payload: ChangeRequestPayload;
  idempotencyKey: string | null;
  isResume: boolean;
}

// DEV_NOTE: A step after which the change request needs another (finishCommit → Verify, finishVerify → Undo,
// startFollowUp → either); no followUp = it ended (or the step was refused)
export interface FollowUpResponse extends ChangeRequestStepResponse {
  followUp?: FollowUpPlan;
}

// DEV_NOTE: What an edit is checked against: the tool as stored for this change request (re-checked Active) and the
// decrypted payload (its args are what the edit starts from)
export interface EditPlan {
  changeRequestPublicId: string;
  tool: RuntimeTool;
  payload: ChangeRequestPayload;
}

export interface GetEditPlanResponse extends ChangeRequestStepResponse {
  plan?: EditPlan;
}

export interface ChangeRequestViewsResponse extends ApiResponse {
  changeRequests?: WidgetChangeRequest[];
}

// DEV_NOTE: How many change requests the purge (M3-7) emptied in one run
export interface PurgeChangeRequestValuesResponse extends ApiResponse {
  purgedCount?: number;
}

// DEV_NOTE: The turn's tools, and how many pins were left out (Disabled, Draft or missing version, connection not
// Active, ops that don't load, an input_schema that can't be checked: each logged). A read-only company's write tools
// are not loaded and not counted.
export interface LoadTurnToolsResponse extends ApiResponse {
  tools?: RuntimeTool[];
  skippedCount?: number;
}

// DEV_NOTE: Server-side only (inside ActionEngineRepo) — the conversation, company and chatbot as a step finds them
// (rootLogId parents the step's event), or why the step can't go on
export type ChangeRequestConversationCheck =
  | { isSuccess: true; rootLogId: string | null; isReadOnly: boolean }
  | { isSuccess: false; failure: ChangeRequestFailureEnum; message?: string };
