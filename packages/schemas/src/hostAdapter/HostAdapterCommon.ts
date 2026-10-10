import type { ApiResponse } from "../common";
import type {
  CompanyConnection,
  CompanyConnectionAuthTypeEnum,
} from "../companyConnections/CompanyConnectionsCommon";
import type {
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
} from "../toolDefinitions/ToolDefinitionsCommon";
import type { RenderedToolRequest } from "../toolDefinitions/ToolOpRenderer";
import type { ReadbackCheckExpectations } from "../toolDefinitions/ToolReadbackCompare";

// DEV_NOTE: Host API calls (@app/adapter, M3-2). A failed or slow attempt is tried again at most HOST_CALL_MAX_RETRIES
// times (when its idempotency mode allows it): after the host's Retry-After when it gives one (capped), else
// HOST_CALL_RETRY_BASE_MS doubled per retry. Each attempt, body read included, has HOST_CALL_TIMEOUT_MS.
export const HOST_CALL_MAX_RETRIES = 2;
export const HOST_CALL_RETRY_BASE_MS = 500;
export const HOST_CALL_RETRY_AFTER_MAX_MS = 5_000;
export const HOST_CALL_TIMEOUT_MS = 15_000;
// A host response body larger than this is not read (a read fails; a write that answered 2xx still landed)
export const HOST_RESPONSE_MAX_BYTES = 1_048_576;

// DEV_NOTE: Native idempotency sends the caller's key in this header on every attempt of a write (IETF
// draft-ietf-httpapi-idempotency-key-header), so the host runs it once. A key is printable ASCII with no spaces.
export const HOST_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const HOST_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

// DEV_NOTE: How a host call ended.
//   Succeeded: the host answered 2xx (a write landed; body is its response when readable).
//   AlreadyApplied: an Emulated write's readback showed the write had already landed, so it wasn't sent again.
//   Refused: the host answered a 4xx that a retry won't change (403, 404, 422, …), and no earlier send may have landed.
//   TokenNeeded: no usable host token in memory; nothing was sent with this attempt (M3-8 fetches one).
//   TokenRejected: the host answered 401 to the token (or the token is malformed).
//   Unknown: a write may or may not have landed (timeout, dropped connection, 5xx, retries used up, a readback that
//     matches neither side): resume it later with isResume, or hand it to a human (Mode None never resends).
//   Failed: the call couldn't be made or didn't succeed, and no send of a write may have landed.
// Refused and Failed are never returned after a send that may have landed (those become Unknown). TokenNeeded and
// TokenRejected are, so the token can be refreshed: for a write, read mayHaveLanded on every outcome that isn't a
// success, and pass it as isResume on the next call for the step.
export enum HostCallOutcomeEnum {
  Succeeded = "Succeeded",
  AlreadyApplied = "AlreadyApplied",
  Refused = "Refused",
  TokenNeeded = "TokenNeeded",
  TokenRejected = "TokenRejected",
  Unknown = "Unknown",
  Failed = "Failed",
}

// The connection fields the adapter uses; the caller has already checked it is the company's and Active
export type HostConnection = Pick<
  CompanyConnection,
  "adapterType" | "baseUrl" | "authType" | "authConfig" | "credentialScope"
>;

// DEV_NOTE: Reads the chatbot user's host bearer token from DO memory, per attempt, so a token refreshed between
// retries is used. Never stored or logged by the adapter (pattern rule 3.11).
export type HostTokenSource = () => string | null;

// Waits between retries; injectable so tests don't sleep
export type HostRetryWait = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface CreateHostAdapterRequest {
  connection: HostConnection;
  getHostToken: HostTokenSource;
  fetch?: typeof fetch;
  wait?: HostRetryWait;
}

// DEV_NOTE: The Emulated "did it land?" check: the tool's readback_op rendered with the args, and the values that prove
// each side (getCommitCheckExpectations for a commit, getUndoCheckExpectations for an undo). Landed = the readback
// shows the step's values; not landed = it still shows the values the step replaces. A readback that shows neither
// (the host stored the value in another form: lowercased, rounded, "20.00" for 20) proves nothing, so the write is
// never resent on it.
export interface HostAppliedCheck {
  request: RenderedToolRequest;
  expectations: ReadbackCheckExpectations;
}

// DEV_NOTE: A read: call_op of a read tool, or a readback_op. Always safe to send again.
export interface HostReadCall {
  request: RenderedToolRequest;
  signal?: AbortSignal;
}

// DEV_NOTE: A write: call_op of a write tool (commit) or its inverse_op (undo). key is the change request's key for this
// step (a commit and its undo use different keys). appliedCheck is required for Emulated. isResume = an earlier call
// for the same step may have reached the host (Unknown, or the DO was evicted mid-call): Native resends with the same
// key, Emulated checks first, None returns Unknown without sending.
export interface HostWriteCall extends HostReadCall {
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum;
  idempotencyKey: string;
  appliedCheck: HostAppliedCheck | null;
  isResume: boolean;
}

// DEV_NOTE: call_op of a tool, tagged with the tool's risk so a write can never be sent with the read rules
export type HostExecuteCall =
  | (HostReadCall & { risk: ToolDefinitionRiskIntEnum.Read })
  | (HostWriteCall & {
      risk: ToolDefinitionRiskIntEnum.Write | ToolDefinitionRiskIntEnum.Destructive;
    });

export interface HostCallResponse extends ApiResponse {
  outcome: HostCallOutcomeEnum;
  // The host's last HTTP status, when it answered
  httpStatus?: number;
  // The parsed JSON response of a Succeeded call (null = empty body); undefined when unreadable or not Succeeded
  body?: unknown;
  // Requests this call sent for the step itself (an Emulated readback check isn't counted)
  attempts: number;
  // A write only, on every outcome: whether one of its sends may have landed. When true on an outcome that isn't a
  // success (Unknown, TokenNeeded, TokenRejected), the next call for this step must pass isResume: true.
  mayHaveLanded?: boolean;
}

// DEV_NOTE: One auth type's headers for an attempt. headers go only on the request to the connection's base_url;
// a failure carries TokenNeeded / TokenRejected / Failed and a message that never holds the credential.
export interface HostAuthHeadersResponse extends ApiResponse {
  headers?: Record<string, string>;
  failureOutcome?:
    | HostCallOutcomeEnum.TokenNeeded
    | HostCallOutcomeEnum.TokenRejected
    | HostCallOutcomeEnum.Failed;
}

// DEV_NOTE: The AuthStrategy interface (registry in @app/adapter): config-driven, no per-customer code. authConfig has
// already passed getAuthConfigIssue for authType.
export interface HostAuthStrategy {
  authType: CompanyConnectionAuthTypeEnum;
  getHeaders(params: {
    authConfig: unknown;
    getHostToken: HostTokenSource;
  }): HostAuthHeadersResponse;
}

// DEV_NOTE: The adapter interface (architecture: execute · readback · undo; getSchema arrives with OpenAPI import,
// M7-2). Requests come from renderToolOp, after the args are checked against input_schema. Never throws.
export interface HostAdapter {
  execute(call: HostExecuteCall): Promise<HostCallResponse>;
  readback(call: HostReadCall): Promise<HostCallResponse>;
  undo(call: HostWriteCall): Promise<HostCallResponse>;
}

export interface CreateHostAdapterResponse extends ApiResponse {
  adapter?: HostAdapter;
}

// ─── Internal to packages/adapter ───────────────────────────────────────────

// DEV_NOTE: One HTTP attempt's result (HostHttp.sendHostAttempt)
export enum HostAttemptKindEnum {
  // The host answered with a status (its body read or not)
  Answered = "Answered",
  // fetch failed or timed out: the request may have reached the host
  NoAnswer = "NoAnswer",
  // The caller aborted: the request may have reached the host
  Aborted = "Aborted",
}

export type HostAttemptResult =
  | {
      kind: HostAttemptKindEnum.Answered;
      status: number;
      retryAfterMs: number | null;
      // An empty body is readable (null); non-JSON, over the size cap or cut off is not
      isReadable: boolean;
      body: unknown;
    }
  | { kind: HostAttemptKindEnum.NoAnswer | HostAttemptKindEnum.Aborted };

export type HostUrlResult = { isSuccess: true; url: URL } | { isSuccess: false; message: string };

// A connection's base_url, checked once when the adapter is created
export type HostBaseUrlResult =
  | { isSuccess: true; baseUrl: URL }
  | { isSuccess: false; message: string };

// DEV_NOTE: A write's progress across its attempts: requests sent, and whether one of them may have landed
export interface HostWriteState {
  attempts: number;
  mayHaveLanded: boolean;
}

// DEV_NOTE: The Emulated "did it land?" check: Inconclusive = the readback couldn't be read, or matches neither side,
// so the write is neither resent nor counted as landed
export enum HostAppliedCheckStateEnum {
  Applied = "Applied",
  NotApplied = "NotApplied",
  Inconclusive = "Inconclusive",
}

export interface HostAppliedCheckResult {
  state: HostAppliedCheckStateEnum;
  // The readback's outcome when Inconclusive (TokenNeeded / TokenRejected are passed on as they are)
  outcome?: HostCallOutcomeEnum;
  message?: string;
}
