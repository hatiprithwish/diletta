import type { ConversationSession } from "../conversations/ConversationsCommon";
import type { RuntimeTool, ToolCallErrorCodeEnum, ToolCallStatusIntEnum } from "../toolCalls";
import type {
  ChangeRequestChange,
  ChangeRequestDecisionEnum,
  ChangeRequestKindEnum,
  ChangeRequestPayload,
} from "./ChangeRequestsCommon";
import type { HostCallResponse } from "../hostAdapter/HostAdapterCommon";
import type { CommitPlan, FollowUpPlan } from "./ChangeRequestsResponse";

// DEV_NOTE: Server-side only (Conversation DO → ActionEngineRepo). Every internal id comes from the DO's verified
// session or rows the Repo read; tool is the turn's loaded tool. Args are already checked against input_schema and are
// encrypted by the Repo before the DAL (CompanyKeyProvider).

// A tool call that ended without a proposal: a read, a refused call, or a write the model asked for twice
export interface RecordToolCallRequest {
  session: ConversationSession;
  turnId: string;
  tool: RuntimeTool;
  args: Record<string, unknown> | null;
  status: ToolCallStatusIntEnum;
  errorCode: ToolCallErrorCodeEnum | null;
  latencyMs: number | null;
  hasUntrustedContext: boolean;
}

// DEV_NOTE: A write's proposal: its tool call, the change request (Proposed, or Approved when no approval is needed)
// and their events, in one transaction. isApprovalRequired is the approval rules' answer; isApprovedByEval: an eval
// attempt (M5-2) approved it on its test user's behalf (Approved at once, logged as such, never as automatic).
export interface ProposeChangeRequest {
  session: ConversationSession;
  turnId: string;
  tool: RuntimeTool;
  args: Record<string, unknown>;
  kind: ChangeRequestKindEnum;
  before: unknown;
  changes: ChangeRequestChange[];
  isApprovalRequired: boolean;
  isApprovedByEval: boolean;
  hasUntrustedContext: boolean;
  latencyMs: number;
}

// DEV_NOTE: The user's answer (Approve / Reject), or the expiry (isExpired, Proposed → Expired). The deadline is the
// row's created_at + CHANGE_REQUEST_APPROVAL_EXPIRY_MS: an approval after it ends the proposal Expired instead.
export interface DecideChangeRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  decision: ChangeRequestDecisionEnum;
  isExpired: boolean;
}

// DEV_NOTE: attemptId (a fresh ULID per commit attempt) parts a resumed attempt's committing event from the others, so
// a retried transaction of the same attempt dedupes. isUnsent (M3-8): the DO's entry knows its last attempt reached
// nothing (its token was missing or refused on the first send), so a Committing row is sent fresh (isResume false).
export interface StartCommitRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  attemptId: string;
  isUnsent: boolean;
}

// DEV_NOTE: How the commit's host call ended (@app/adapter), for the change request's status. plan: the one
// startCommit handed out (isResume: an earlier attempt may have reached the host; tool: its readback reads the result
// for the read-after). body: the commit's response, kept for the read-after and the undo (M3-6).
export interface FinishCommitRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  hostCall: Pick<HostCallResponse, "outcome" | "mayHaveLanded" | "attempts" | "body">;
  plan: CommitPlan;
}

// DEV_NOTE: The next step of a landed commit that an eviction or a failed write cut short (M3-6): a Committed one is
// read back, a Mismatch one undone. attemptId (a fresh ULID) parts a resumed undo's undoing event from the others.
// isUnsent (M3-8): the undo's last send reached nothing (token missing or refused), so it is sent fresh (isResume false).
export interface StartFollowUpRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  attemptId: string;
  isUnsent: boolean;
}

// DEV_NOTE: The user's undo of a Verified change request (M3-7), from the widget's change_request_undos frame.
// attemptId (a fresh ULID) parts this undo's undoing event from a resumed one's.
export interface StartUndoRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  attemptId: string;
}

// DEV_NOTE: A user undo cut short that the DO stops waiting for (M3-7): handed to a person (NeedsHuman undo_interrupted)
export interface AbandonUndoRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
}

// DEV_NOTE: A step past the user's answer that waited HOST_TOKEN_GRACE_MS for a host token that never came (the widget
// closed, M3-8): handed to a person (NeedsHuman token_needed)
export interface HandOverForTokenRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
}

// DEV_NOTE: How the read-after ended (@app/adapter readback), for Verified / Mismatch / NeedsHuman. plan: the one the
// Repo handed out.
export interface FinishVerifyRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  plan: FollowUpPlan;
  readback: Pick<HostCallResponse, "outcome" | "httpStatus" | "body" | "attempts">;
}

// DEV_NOTE: How an undo ended (the auto-undo of a Mismatch, or the user's undo of a Verified one, M3-7): its host
// call, and the read after it (null when the undo didn't succeed, so nothing was read), for Undone / NeedsHuman (or,
// for the user's undo that nothing may have reached the host, back to Verified)
export interface FinishUndoRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  plan: FollowUpPlan;
  undo: Pick<HostCallResponse, "outcome" | "mayHaveLanded" | "attempts">;
  readback: Pick<HostCallResponse, "outcome" | "httpStatus" | "body" | "attempts"> | null;
}

export interface GetChangeRequestViewsRequest {
  session: ConversationSession;
  changeRequestPublicIds: string[];
}

export interface SetExecutionIdRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  thinkExecutionId: string;
}

// DEV_NOTE: isReadOnly: the company is read-only (is_read_only), so only its read tools load
export interface LoadTurnToolsRequest {
  session: ConversationSession;
  pins: { name: string; version: number }[];
  isReadOnly: boolean;
}

// DEV_NOTE: An edit's first step (M3-5): what the edit is checked against, read from a Proposed change request still
// before its deadline (the conversation, chatbot and company re-checked, the tool version still loading)
export interface GetEditPlanRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
}

// DEV_NOTE: An edit's last step: the re-checked payload (the edited args, the fresh read-before and the diff rebuilt
// from both) replaces the stored one, only while the change request is still Proposed and before its deadline.
// editId (a fresh ULID per edit) parts this edit's event from the others.
export interface SaveEditRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  payload: ChangeRequestPayload;
  editId: string;
}

// DEV_NOTE: Mark resolved (M4-5), server-side: companyId and adminId (internal) from the signed-in admin, publicId
// from the route
export interface ResolveChangeRequestRequest {
  companyId: string;
  adminId: string;
  publicId: string;
}
