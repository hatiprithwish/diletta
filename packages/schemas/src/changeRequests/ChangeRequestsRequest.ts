import type { ConversationSession } from "../conversations/ConversationsCommon";
import type { RuntimeTool, ToolCallErrorCodeEnum, ToolCallStatusIntEnum } from "../toolCalls";
import type {
  ChangeRequestChange,
  ChangeRequestDecisionEnum,
  ChangeRequestKindEnum,
} from "./ChangeRequestsCommon";
import type { HostCallResponse } from "../hostAdapter/HostAdapterCommon";

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
// and their events, in one transaction
export interface ProposeChangeRequest {
  session: ConversationSession;
  turnId: string;
  tool: RuntimeTool;
  args: Record<string, unknown>;
  kind: ChangeRequestKindEnum;
  before: unknown;
  changes: ChangeRequestChange[];
  isApprovalRequired: boolean;
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
// a retried transaction of the same attempt dedupes
export interface StartCommitRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  attemptId: string;
}

// DEV_NOTE: How the commit's host call ended (@app/adapter), for the change request's final status. isResume: the
// commit plan's (an earlier attempt may have reached the host).
export interface FinishCommitRequest {
  session: ConversationSession;
  changeRequestPublicId: string;
  hostCall: Pick<HostCallResponse, "outcome" | "mayHaveLanded" | "attempts">;
  isResume: boolean;
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
