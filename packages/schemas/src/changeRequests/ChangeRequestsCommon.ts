import { z } from "zod";
import { ZBytes } from "../common";
import type { ToolDefinitionRiskIntEnum } from "../toolDefinitions/ToolDefinitionsCommon";

export enum ChangeRequestStatusIntEnum {
  Proposed = 1,
  Approved = 2,
  Rejected = 3,
  Committing = 4,
  Committed = 5,
  Verified = 6,
  Mismatch = 7,
  Failed = 8,
  Undone = 9,
  Expired = 10,
  NeedsHuman = 11,
}

export enum ChangeRequestStatusLabelEnum {
  Proposed = "Proposed",
  Approved = "Approved",
  Rejected = "Rejected",
  Committing = "Committing",
  Committed = "Committed",
  Verified = "Verified",
  Mismatch = "Mismatch",
  Failed = "Failed",
  Undone = "Undone",
  Expired = "Expired",
  NeedsHuman = "Needs review",
}

export const CHANGE_REQUEST_STATUS_LABEL_MAP: Record<
  ChangeRequestStatusIntEnum,
  ChangeRequestStatusLabelEnum
> = {
  [ChangeRequestStatusIntEnum.Proposed]: ChangeRequestStatusLabelEnum.Proposed,
  [ChangeRequestStatusIntEnum.Approved]: ChangeRequestStatusLabelEnum.Approved,
  [ChangeRequestStatusIntEnum.Rejected]: ChangeRequestStatusLabelEnum.Rejected,
  [ChangeRequestStatusIntEnum.Committing]: ChangeRequestStatusLabelEnum.Committing,
  [ChangeRequestStatusIntEnum.Committed]: ChangeRequestStatusLabelEnum.Committed,
  [ChangeRequestStatusIntEnum.Verified]: ChangeRequestStatusLabelEnum.Verified,
  [ChangeRequestStatusIntEnum.Mismatch]: ChangeRequestStatusLabelEnum.Mismatch,
  [ChangeRequestStatusIntEnum.Failed]: ChangeRequestStatusLabelEnum.Failed,
  [ChangeRequestStatusIntEnum.Undone]: ChangeRequestStatusLabelEnum.Undone,
  [ChangeRequestStatusIntEnum.Expired]: ChangeRequestStatusLabelEnum.Expired,
  [ChangeRequestStatusIntEnum.NeedsHuman]: ChangeRequestStatusLabelEnum.NeedsHuman,
};

// DEV_NOTE: Action engine platform defaults (M3-4). A proposal waits CHANGE_REQUEST_APPROVAL_EXPIRY_MS for the user's
// decision (a DO schedule, then Expired). A conversation holds at most CHANGE_REQUEST_MAX_PENDING proposals at a time:
// bulk review shows them together, and commits run in the Conversation DO with the user's in-memory host token, so
// there is no Workflow for large batches in v1.
export const CHANGE_REQUEST_APPROVAL_EXPIRY_MS = 15 * 60_000;
export const CHANGE_REQUEST_MAX_PENDING = 20;

// DEV_NOTE: What a change request does to the host record, from its tool: a Write with a read-before updates an
// existing record; a Write whose readback reads the call's result (a new id) creates one, with nothing to read before;
// a Destructive tool deletes the record its read-before found.
export enum ChangeRequestKindEnum {
  Update = "update",
  Create = "create",
  Delete = "delete",
}

// DEV_NOTE: One compare field's value: found (any JSON) or absent. Host data: it lives only inside the encrypted
// payload and the widget's change_request frame, never in a log, the transcript or the read model.
export const ZChangeRequestValue = z.discriminatedUnion("isFound", [
  z.object({ isFound: z.literal(true), value: z.json() }),
  z.object({ isFound: z.literal(false) }),
]);
export type ChangeRequestValue = z.infer<typeof ZChangeRequestValue>;

// DEV_NOTE: One row of the diff, built from the read-before and the real args (never from the model's summary). field
// is the compare key, i.e. the input_schema property. isChanged false = the record already holds that value.
export const ZChangeRequestChange = z.object({
  field: z.string(),
  before: ZChangeRequestValue,
  after: ZChangeRequestValue,
  isChanged: z.boolean(),
});
export type ChangeRequestChange = z.infer<typeof ZChangeRequestChange>;

// DEV_NOTE: change_requests.encrypted_changes, as JSON before encryption (CompanyKeyProvider): the validated args the
// commit sends, the read-before response (the {before.*} of the undo, M3-7; null when there was no read-before) and
// the diff the user approved. Purged after the undo window (M3-7). version = this payload's own shape.
export const ZChangeRequestPayload = z.object({
  version: z.literal(1),
  kind: z.enum(ChangeRequestKindEnum),
  args: z.record(z.string(), z.json()),
  before: z.json().nullable(),
  changes: z.array(ZChangeRequestChange),
});
export type ChangeRequestPayload = z.infer<typeof ZChangeRequestPayload>;

// DEV_NOTE: change_requests.error_code: why a change request ended Failed or NeedsHuman. The step was refused before
// the host call (the conversation, chatbot, company or tool no longer allowed it, or the payload couldn't be read), or
// the host call ended so (@app/adapter outcome).
export enum ChangeRequestErrorCodeEnum {
  ConversationClosed = "conversation_closed",
  ChatbotUnavailable = "chatbot_unavailable",
  ReadOnly = "read_only",
  ToolUnavailable = "tool_unavailable",
  PayloadUnreadable = "payload_unreadable",
  ServerError = "server_error",
  TokenNeeded = "token_needed",
  TokenRejected = "token_rejected",
  HostRefused = "host_refused",
  HostFailed = "host_failed",
  HostUnknown = "host_unknown",
}

// Whole Change Request Body — DB shape (status stored as integer)
// DEV_NOTE: id, companyId, conversationId and toolCallId are internal — NEVER sent to a client. encryptedChanges + iv +
// encryptionKeyVersion hold the ChangeRequestPayload; null once purged. thinkExecutionId is the durable pause's
// execution id, filled once the turn parked.
export const ZChangeRequest = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  conversationId: z.string(),
  toolCallId: z.string(),
  status: z.enum(ChangeRequestStatusIntEnum),
  encryptedChanges: ZBytes.nullable(),
  iv: ZBytes.nullable(),
  encryptionKeyVersion: z.number().int().nullable(),
  summary: z.string(),
  changeCount: z.number().int(),
  wasEdited: z.boolean(),
  thinkExecutionId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  hostRef: z.string().nullable(),
  undoUntil: z.date().nullable(),
  errorCode: z.enum(ChangeRequestErrorCodeEnum).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChangeRequest = z.infer<typeof ZChangeRequest>;

// DEV_NOTE: A change request as the DAL reads it: with its tool call's tool, version and turn (risk, ops and
// idempotency mode come through the tool, per the table note), and the tool's name and whether it can be undone
// (inverse_op set). toolName and toolRisk are null when the tool definition row is gone (no DB foreign keys).
export type ChangeRequestRow = ChangeRequest & {
  toolId: string;
  toolVersion: number;
  turnId: string;
  toolName: string | null;
  toolRisk: ToolDefinitionRiskIntEnum | null;
  isUndoable: boolean;
};

// DEV_NOTE: Client-facing — one change request as the widget shows it (change_request frame). changes are null once
// purged, and kind too then, unless the tool is destructive (a delete): a create and an update read alike without the
// payload. expiresAt (epoch ms) only while Proposed. Internal ids structurally absent; toolName and field names are
// machine values (font-mono in the UI).
export const ZWidgetChangeRequest = z.object({
  publicId: z.string(),
  toolName: z.string(),
  kind: z.enum(ChangeRequestKindEnum).nullable(),
  changeRequestStatus: z.enum(ChangeRequestStatusIntEnum),
  changeRequestStatusLabel: z.enum(ChangeRequestStatusLabelEnum),
  summary: z.string(),
  changes: z.array(ZChangeRequestChange).nullable(),
  changeCount: z.number().int(),
  expiresAt: z.number().int().nullable(),
  isUndoable: z.boolean(),
});
export type WidgetChangeRequest = z.infer<typeof ZWidgetChangeRequest>;

// DEV_NOTE: The user's answer to a proposal, from the widget's change_request_decision frame
export enum ChangeRequestDecisionEnum {
  Approve = "approve",
  Reject = "reject",
}

// DEV_NOTE: Why a change request step was refused (server-side only, ActionEngineRepo → Conversation DO).
//   NotFound: no change request of this conversation has that public id.
//   InvalidTransition: it isn't in a status the step starts from (already decided, expired, committed).
//   ConversationClosed / ChatbotUnavailable: re-checked on every step (rule 3.23).
//   ReadOnly: the company is read-only (is_read_only): the agent may only read, so nothing commits.
//   ToolUnavailable: the tool version or its connection is no longer Active, or its ops no longer load.
export enum ChangeRequestFailureEnum {
  NotFound = "NotFound",
  InvalidTransition = "InvalidTransition",
  ConversationClosed = "ConversationClosed",
  ChatbotUnavailable = "ChatbotUnavailable",
  ReadOnly = "ReadOnly",
  ToolUnavailable = "ToolUnavailable",
  ServerError = "ServerError",
}

// DEV_NOTE: The activity_log / event_outbox names of change request events: one per status change, so the timeline
// (M4-5) reads straight from activity_log. Spelled once here, since the dedupe key is what makes a repeat a no-op.
export const CHANGE_REQUEST_ENTITY_TYPE = "change_request";

export enum ChangeRequestEntityActionEnum {
  Proposed = "proposed",
  Approved = "approved",
  Rejected = "rejected",
  Expired = "expired",
  Committing = "committing",
  Committed = "committed",
  Failed = "failed",
  NeedsHuman = "needs_human",
}

export const CHANGE_REQUEST_STATUS_ENTITY_ACTION_MAP: Partial<
  Record<ChangeRequestStatusIntEnum, ChangeRequestEntityActionEnum>
> = {
  [ChangeRequestStatusIntEnum.Proposed]: ChangeRequestEntityActionEnum.Proposed,
  [ChangeRequestStatusIntEnum.Approved]: ChangeRequestEntityActionEnum.Approved,
  [ChangeRequestStatusIntEnum.Rejected]: ChangeRequestEntityActionEnum.Rejected,
  [ChangeRequestStatusIntEnum.Expired]: ChangeRequestEntityActionEnum.Expired,
  [ChangeRequestStatusIntEnum.Committing]: ChangeRequestEntityActionEnum.Committing,
  [ChangeRequestStatusIntEnum.Committed]: ChangeRequestEntityActionEnum.Committed,
  [ChangeRequestStatusIntEnum.Failed]: ChangeRequestEntityActionEnum.Failed,
  [ChangeRequestStatusIntEnum.NeedsHuman]: ChangeRequestEntityActionEnum.NeedsHuman,
};

export const changeRequestEventType = (action: ChangeRequestEntityActionEnum): string =>
  `${CHANGE_REQUEST_ENTITY_TYPE}.${action}`;

// DEV_NOTE: <event type>:<change request publicId>[:<part>…]. A commit resumed after an eviction marks Committing again
// with a new attempt part, so each attempt is on the timeline.
export const changeRequestEventDedupeKey = (
  action: ChangeRequestEntityActionEnum,
  changeRequestPublicId: string,
  ...parts: string[]
): string => [changeRequestEventType(action), changeRequestPublicId, ...parts].join(":");

// DEV_NOTE: The commit's Idempotency-Key (Native) and change_requests.idempotency_key: one per change request and step,
// the same on every attempt and every resume (an undo, M3-7, uses its own)
export const changeRequestCommitIdempotencyKey = (changeRequestPublicId: string): string =>
  `cr-${changeRequestPublicId}-commit`;
