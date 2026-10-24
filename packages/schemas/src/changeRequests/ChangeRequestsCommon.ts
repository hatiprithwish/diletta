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
  Resolved = 12,
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
  NeedsHuman = "Needs a person",
  Resolved = "Resolved",
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
  [ChangeRequestStatusIntEnum.Resolved]: ChangeRequestStatusLabelEnum.Resolved,
};

// DEV_NOTE: Action engine platform defaults (M3-4). A proposal waits CHANGE_REQUEST_APPROVAL_EXPIRY_MS for the user's
// decision (a DO schedule, then Expired). A conversation holds at most CHANGE_REQUEST_MAX_PENDING proposals at a time:
// bulk review shows them together, and commits run in the Conversation DO with the user's in-memory host token, so
// there is no Workflow for large batches in v1.
export const CHANGE_REQUEST_APPROVAL_EXPIRY_MS = 15 * 60_000;
export const CHANGE_REQUEST_MAX_PENDING = 20;

// DEV_NOTE: The undo window (M3-7), a platform default. A change request that ends (Verified, Undone, Failed, Rejected,
// Expired) gets undo_until = its end + CHANGE_REQUEST_UNDO_WINDOW_MS: a Verified one can be undone by the user until
// then, and every one's values (encrypted_changes) are purged after it. NeedsHuman keeps undo_until null: its values
// stay until a person resolves it (M4-5: an admin's Mark resolved → Resolved, undo_until = now, so the next purge
// empties them). The conversation doesn't auto-close while a Verified one can be undone.
export const CHANGE_REQUEST_UNDO_WINDOW_MS = 60 * 60_000;

// DEV_NOTE: A user undo cut short (an eviction, a failed write) resumes only once the widget sends the host token
// again. If it hasn't by undo_until + CHANGE_REQUEST_UNDO_GRACE_MS, the DO hands it to a person (NeedsHuman
// undo_interrupted: it may have been sent), and the purge stops sparing its values.
export const CHANGE_REQUEST_UNDO_GRACE_MS = 60 * 60_000;

// DEV_NOTE: The statuses whose values are purged a window after they end (CHANGE_REQUEST_UNDO_WINDOW_MS)
export const CHANGE_REQUEST_PURGED_STATUSES: ReadonlySet<ChangeRequestStatusIntEnum> = new Set([
  ChangeRequestStatusIntEnum.Verified,
  ChangeRequestStatusIntEnum.Undone,
  ChangeRequestStatusIntEnum.Failed,
  ChangeRequestStatusIntEnum.Rejected,
  ChangeRequestStatusIntEnum.Expired,
]);

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

// DEV_NOTE: One compare field the read-after (M3-6) found other than the commit set it: expected = what the commit
// sent (absent for a delete: the record should be gone), found = what the record shows. Host data, like a diff row.
export const ZChangeRequestMismatch = z.object({
  field: z.string(),
  expected: ZChangeRequestValue,
  found: ZChangeRequestValue,
});
export type ChangeRequestMismatch = z.infer<typeof ZChangeRequestMismatch>;

// DEV_NOTE: change_requests.encrypted_changes, as JSON before encryption (CompanyKeyProvider): the validated args the
// commit sends, the read-before response (the {before.*} of the undo; null when there was no read-before) and the
// diff the user approved. v2 (M3-6) adds the commit's response (result: the {result.*} of the read-after and the undo,
// null until the commit answers or when its body was empty or unreadable) and what the read-after found other than
// the commit set (mismatches, null until a read-after found any). Purged after the undo window (M3-7). version = this
// payload's own shape: never edit a released one; parseChangeRequestPayload upgrades an older one on read.
export const ZChangeRequestPayloadV1 = z.object({
  version: z.literal(1),
  kind: z.enum(ChangeRequestKindEnum),
  args: z.record(z.string(), z.json()),
  before: z.json().nullable(),
  changes: z.array(ZChangeRequestChange),
});

export const ZChangeRequestPayload = z.object({
  version: z.literal(2),
  kind: z.enum(ChangeRequestKindEnum),
  args: z.record(z.string(), z.json()),
  before: z.json().nullable(),
  changes: z.array(ZChangeRequestChange),
  result: z.json().nullable(),
  mismatches: z.array(ZChangeRequestMismatch).nullable(),
});
export type ChangeRequestPayload = z.infer<typeof ZChangeRequestPayload>;

// DEV_NOTE: A stored payload at today's shape (v1 → v2: no result or mismatches yet), or null when it is neither
export function parseChangeRequestPayload(value: unknown): ChangeRequestPayload | null {
  const current = ZChangeRequestPayload.safeParse(value);
  if (current.success) return current.data;
  const v1 = ZChangeRequestPayloadV1.safeParse(value);
  if (!v1.success) return null;
  return { ...v1.data, version: 2, result: null, mismatches: null };
}

// DEV_NOTE: change_requests.error_code: why a change request ended Failed or NeedsHuman. The step was refused before
// the host call (the conversation, chatbot, company or tool no longer allowed it, or the payload couldn't be read), or
// the host call ended so (@app/adapter outcome). After a commit landed (M3-6): the read-after couldn't tell whether the
// record shows the change (verify_unknown); it didn't, and the tool has no inverse_op (not_undoable); the undo didn't
// succeed (undo_failed), or it did but the record doesn't read back as before (undo_unconfirmed). The user's undo
// (M3-7) was cut short and the user never came back to finish it (undo_interrupted: it may have been sent).
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
  VerifyUnknown = "verify_unknown",
  NotUndoable = "not_undoable",
  UndoFailed = "undo_failed",
  UndoUnconfirmed = "undo_unconfirmed",
  UndoInterrupted = "undo_interrupted",
}

// DEV_NOTE: The dashboard's words for why a change request failed or needs a person (M4-4, DESIGN.md §8 copy)
export const CHANGE_REQUEST_ERROR_LABEL_MAP: Record<ChangeRequestErrorCodeEnum, string> = {
  [ChangeRequestErrorCodeEnum.ConversationClosed]: "The conversation had closed",
  [ChangeRequestErrorCodeEnum.ChatbotUnavailable]: "The chatbot was paused",
  [ChangeRequestErrorCodeEnum.ReadOnly]: "Read-only mode was on",
  [ChangeRequestErrorCodeEnum.ToolUnavailable]: "The tool was no longer available",
  [ChangeRequestErrorCodeEnum.PayloadUnreadable]: "The saved change couldn't be read",
  [ChangeRequestErrorCodeEnum.ServerError]: "Something went wrong on our side",
  [ChangeRequestErrorCodeEnum.TokenNeeded]: "The user's sign-in ran out before it was saved",
  [ChangeRequestErrorCodeEnum.TokenRejected]: "Your app refused the sign-in",
  [ChangeRequestErrorCodeEnum.HostRefused]: "Your app refused the change",
  [ChangeRequestErrorCodeEnum.HostFailed]: "Your app failed to save it",
  [ChangeRequestErrorCodeEnum.HostUnknown]: "Unknown whether your app saved it",
  [ChangeRequestErrorCodeEnum.VerifyUnknown]: "The saved values couldn't be checked",
  [ChangeRequestErrorCodeEnum.NotUndoable]: "The check failed and the tool can't undo",
  [ChangeRequestErrorCodeEnum.UndoFailed]: "The check failed and the undo didn't work",
  [ChangeRequestErrorCodeEnum.UndoUnconfirmed]:
    "The check failed and the undo couldn't be confirmed",
  [ChangeRequestErrorCodeEnum.UndoInterrupted]: "An undo was cut short",
};

export const ZChangeRequestErrorCode = z.enum(ChangeRequestErrorCodeEnum);

// DEV_NOTE: change_requests.error_code is text, so a stored code may be one the enum no longer knows (renamed, or
// written by another build): it keeps reading, as ServerError's code and words. null stays null.
export function changeRequestErrorOf(code: string | null): {
  errorCode: ChangeRequestErrorCodeEnum | null;
  errorLabel: string | null;
} {
  if (code === null) return { errorCode: null, errorLabel: null };
  const parsed = ZChangeRequestErrorCode.safeParse(code);
  const errorCode = parsed.success ? parsed.data : ChangeRequestErrorCodeEnum.ServerError;
  return { errorCode, errorLabel: CHANGE_REQUEST_ERROR_LABEL_MAP[errorCode] };
}

// DEV_NOTE: Who undid an Undone change request (M3-7): the user (their Undo within the window) or the system (the
// auto-undo of a Mismatch, M3-6). Read from the undo key the row holds, so it outlives the purge.
export enum ChangeRequestUndoneByEnum {
  User = "user",
  System = "system",
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

// DEV_NOTE: How the widget edits one field of a proposal (M3-5), from the tool's input_schema property. Only args
// call_op sends (query or body) are editable: the args that only pick the record (path) never are, so an edit can't
// point the change at another record. Only scalar types: an object or array arg, or a property with no single scalar
// type, isn't editable. enumValues: the allowed values (a select); format: the JSON Schema format (date → a date
// input). isRequired: the input_schema requires it (the widget can't clear it). The server re-checks every edit
// against input_schema whatever the widget allowed (rule 3.34).
export enum ChangeRequestFieldTypeEnum {
  String = "string",
  Number = "number",
  Integer = "integer",
  Boolean = "boolean",
}

export const ZChangeRequestEditableField = z.object({
  field: z.string(),
  type: z.enum(ChangeRequestFieldTypeEnum),
  enumValues: z.array(z.union([z.string(), z.number(), z.boolean()])).nullable(),
  format: z.string().nullable(),
  isRequired: z.boolean(),
});
export type ChangeRequestEditableField = z.infer<typeof ZChangeRequestEditableField>;

// DEV_NOTE: Client-facing — one change request as the widget shows it (change_request frame). changes are null once
// purged, and kind too then, unless the tool is destructive (a delete): a create and an update read alike without the
// payload. expiresAt (epoch ms) only while Proposed. editableFields only while Proposed (empty otherwise, or when the
// tool no longer loads). toolCallId is Think's tool call id (the model's, already in the transcript; not a database
// id): the widget shows the card in the reply that made the call. null when the DO no longer holds the open entry
// (the call's own output then names the change request). wasEdited: the user changed values (M3-5), so the diff is the
// re-checked one. mismatches (M3-6): what the read-after found other than the commit set (null when it found none, or
// once purged), host data like changes. undoUntil (M3-7, epoch ms): set while the user can undo it (Verified, the tool
// has an inverse_op, the values not purged, before the window ends); isUndoing: the user's undo of it is under way;
// undoneBy: who undid an Undone one (null otherwise).
// Internal ids structurally absent; toolName and field names are machine values (font-mono in the UI).
export const ZWidgetChangeRequest = z.object({
  publicId: z.string(),
  toolName: z.string(),
  toolCallId: z.string().nullable(),
  kind: z.enum(ChangeRequestKindEnum).nullable(),
  changeRequestStatus: z.enum(ChangeRequestStatusIntEnum),
  changeRequestStatusLabel: z.enum(ChangeRequestStatusLabelEnum),
  summary: z.string(),
  changes: z.array(ZChangeRequestChange).nullable(),
  changeCount: z.number().int(),
  expiresAt: z.number().int().nullable(),
  isUndoable: z.boolean(),
  wasEdited: z.boolean(),
  editableFields: z.array(ZChangeRequestEditableField),
  mismatches: z.array(ZChangeRequestMismatch).nullable(),
  undoUntil: z.number().int().nullable(),
  isUndoing: z.boolean(),
  undoneBy: z.enum(ChangeRequestUndoneByEnum).nullable(),
});
export type WidgetChangeRequest = z.infer<typeof ZWidgetChangeRequest>;

// DEV_NOTE: One edit (M3-5): new values for some of a proposal's editable fields, by field name. Bounded: at most
// CHANGE_REQUEST_EDIT_MAX_FIELDS fields, each value's JSON at most CHANGE_REQUEST_EDIT_VALUE_MAX_CHARS.
export const CHANGE_REQUEST_EDIT_MAX_FIELDS = 50;
export const CHANGE_REQUEST_EDIT_VALUE_MAX_CHARS = 4_000;

export const ZChangeRequestEditValues = z
  .record(
    z.string().min(1).max(64),
    z
      .json()
      .refine((value) => JSON.stringify(value).length <= CHANGE_REQUEST_EDIT_VALUE_MAX_CHARS, {
        message: "Value too long",
      }),
  )
  .refine((values) => {
    const count = Object.keys(values).length;
    return count > 0 && count <= CHANGE_REQUEST_EDIT_MAX_FIELDS;
  }, "Between 1 and 50 fields");
export type ChangeRequestEditValues = z.infer<typeof ZChangeRequestEditValues>;

// DEV_NOTE: The user's answer to a proposal, from the widget's change_request_decision frame
export enum ChangeRequestDecisionEnum {
  Approve = "approve",
  Reject = "reject",
}

// DEV_NOTE: Why a change request step was refused (server-side only, ActionEngineRepo → Conversation DO).
//   NotFound: no change request of this conversation has that public id.
//   InvalidTransition: it isn't in a status the step starts from (already decided, expired, committed).
//   PastDeadline: an edit after the approval deadline (the expiry ends it).
//   InvalidEdit: an edit names a field that isn't editable, or its values don't fit the input_schema (M3-5).
//   NoChange: the edited values are what the record already holds, so there is nothing to approve.
//   ConversationClosed / ChatbotUnavailable: re-checked on every step (rule 3.23).
//   ReadOnly: the company is read-only (is_read_only): the agent may only read, so nothing commits.
//   ToolUnavailable: the tool version or its connection is no longer Active, or its ops no longer load.
//   NotUndoable: the user asked to undo one whose tool has no inverse_op (M3-7).
//   UndoWindowClosed: the user asked to undo one after its undo_until, or whose values are purged (M3-7).
export enum ChangeRequestFailureEnum {
  NotFound = "NotFound",
  InvalidTransition = "InvalidTransition",
  PastDeadline = "PastDeadline",
  InvalidEdit = "InvalidEdit",
  NoChange = "NoChange",
  ConversationClosed = "ConversationClosed",
  ChatbotUnavailable = "ChatbotUnavailable",
  ReadOnly = "ReadOnly",
  ToolUnavailable = "ToolUnavailable",
  NotUndoable = "NotUndoable",
  UndoWindowClosed = "UndoWindowClosed",
  ServerError = "ServerError",
}

// DEV_NOTE: The activity_log / event_outbox names of change request events: one per status change, so the timeline
// (M4-5) reads straight from activity_log. Spelled once here, since the dedupe key is what makes a repeat a no-op.
export const CHANGE_REQUEST_ENTITY_TYPE = "change_request";

// DEV_NOTE: Edited (M3-5) and Undoing (M3-6) are the events that aren't a status change: the user changed a Proposed
// one's values (it stays Proposed; each edit is its own event, an edit id part in the dedupe key), and the auto-undo
// of a Mismatch started (its key stored first; a resumed undo writes another, with an attempt part). The user's undo
// of a Verified one (M3-7) writes Undoing too (actor: the chatbot user), while it stays Verified; UndoNotSent marks the
// end of one that reached nothing (it stays Verified, so it isn't a status change either).
export enum ChangeRequestEntityActionEnum {
  Proposed = "proposed",
  Edited = "edited",
  Approved = "approved",
  Rejected = "rejected",
  Expired = "expired",
  Committing = "committing",
  Committed = "committed",
  Failed = "failed",
  NeedsHuman = "needs_human",
  Verified = "verified",
  Mismatch = "mismatch",
  Undoing = "undoing",
  UndoNotSent = "undo_not_sent",
  Undone = "undone",
  Resolved = "resolved",
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
  [ChangeRequestStatusIntEnum.Verified]: ChangeRequestEntityActionEnum.Verified,
  [ChangeRequestStatusIntEnum.Mismatch]: ChangeRequestEntityActionEnum.Mismatch,
  [ChangeRequestStatusIntEnum.Undone]: ChangeRequestEntityActionEnum.Undone,
  [ChangeRequestStatusIntEnum.Resolved]: ChangeRequestEntityActionEnum.Resolved,
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
// the same on every attempt and every resume. The auto-undo of a Mismatch uses its own (changeRequestUndoIdempotencyKey),
// stored in idempotency_key when the undo starts, so a Mismatch holding it may have sent its undo already (a resume).
// The user's undo of a Verified one (M3-7) uses another (changeRequestUserUndoIdempotencyKey): a Verified row holding
// it is that undo under way, and an Undone one holding it was undone by the user (the column is never purged). The
// purge builds the same key in SQL from CHANGE_REQUEST_KEY_PREFIX and CHANGE_REQUEST_USER_UNDO_KEY_SUFFIX.
export const CHANGE_REQUEST_KEY_PREFIX = "cr-";
export const CHANGE_REQUEST_USER_UNDO_KEY_SUFFIX = "-user-undo";

export const changeRequestCommitIdempotencyKey = (changeRequestPublicId: string): string =>
  `${CHANGE_REQUEST_KEY_PREFIX}${changeRequestPublicId}-commit`;

export const changeRequestUndoIdempotencyKey = (changeRequestPublicId: string): string =>
  `${CHANGE_REQUEST_KEY_PREFIX}${changeRequestPublicId}-undo`;

export const changeRequestUserUndoIdempotencyKey = (changeRequestPublicId: string): string =>
  `${CHANGE_REQUEST_KEY_PREFIX}${changeRequestPublicId}${CHANGE_REQUEST_USER_UNDO_KEY_SUFFIX}`;

// DEV_NOTE: The Changes page's tabs (M4-5). Waiting = not ended yet (proposed, or on its way through commit and
// check); Verified, Undone and Needs a person are their own; Rejected, Expired, Failed and Resolved show only under All.
export enum ChangeRequestListTabEnum {
  All = "all",
  Waiting = "waiting",
  Verified = "verified",
  Undone = "undone",
  NeedsHuman = "needs_human",
}

export const ZChangeRequestListTab = z.enum(ChangeRequestListTabEnum);

// DEV_NOTE: The statuses behind each tab; null = every status (All)
export const CHANGE_REQUEST_TAB_STATUSES: Record<
  ChangeRequestListTabEnum,
  ChangeRequestStatusIntEnum[] | null
> = {
  [ChangeRequestListTabEnum.All]: null,
  [ChangeRequestListTabEnum.Waiting]: [
    ChangeRequestStatusIntEnum.Proposed,
    ChangeRequestStatusIntEnum.Approved,
    ChangeRequestStatusIntEnum.Committing,
    ChangeRequestStatusIntEnum.Committed,
    ChangeRequestStatusIntEnum.Mismatch,
  ],
  [ChangeRequestListTabEnum.Verified]: [ChangeRequestStatusIntEnum.Verified],
  [ChangeRequestListTabEnum.Undone]: [ChangeRequestStatusIntEnum.Undone],
  [ChangeRequestListTabEnum.NeedsHuman]: [ChangeRequestStatusIntEnum.NeedsHuman],
};

export enum ChangeRequestSortColumn {
  CreatedAt = "createdAt",
  UpdatedAt = "updatedAt",
}

export const ZChangeRequestSortColumn = z.enum(ChangeRequestSortColumn);

// DEV_NOTE: The Changes page's rows per page (the API's own default page size is smaller)
export const CHANGES_PAGE_SIZE = 25;

// DEV_NOTE: A change request gathers a handful of events (one per status change, an edit or an undo attempt each);
// the timeline shows at most this many, the newest ones (where it stands now), oldest first
export const CHANGE_REQUEST_TIMELINE_MAX_EVENTS = 100;

// DEV_NOTE: The Requested by filter offers at most this many requesters, those with the most changes (plus the one
// the URL picked, when it isn't among them)
export const CHANGE_REQUEST_REQUESTERS_MAX = 50;

// DEV_NOTE: A timeline step's dot: good news (approved, saved, checked, undone, resolved), bad news (failed, a check
// that failed, needs a person) or neither
export enum ChangeRequestTimelineToneEnum {
  Neutral = "neutral",
  Success = "success",
  Destructive = "destructive",
}

// DEV_NOTE: Why Mark resolved was refused: only a change that needs a person can be resolved (409)
export enum ChangeRequestResolveFailureEnum {
  NotNeedsHuman = "NotNeedsHuman",
}

// DEV_NOTE: The parts of a change_request event's activity_log detail the timeline reads (M4-5), each optional: an
// approval with no approver (isAutomatic), the user's own undo (isUserUndo), and why it failed or needs a person
// (errorCode, or reason on the events that record one). Any other key is ignored.
export const ZChangeRequestEventDetail = z.object({
  isAutomatic: z.boolean().optional().catch(undefined),
  isUserUndo: z.boolean().optional().catch(undefined),
  errorCode: z.string().nullable().optional().catch(undefined),
  reason: z.string().nullable().optional().catch(undefined),
});
export type ChangeRequestEventDetail = z.infer<typeof ZChangeRequestEventDetail>;
