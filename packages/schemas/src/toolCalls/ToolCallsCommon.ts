import { z } from "zod";
import { ZBytes } from "../common";
import type { HostConnection } from "../hostAdapter/HostAdapterCommon";
import type {
  ToolDefinitionApprovalIntEnum,
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
} from "../toolDefinitions/ToolDefinitionsCommon";
import type { ToolOps } from "../toolDefinitions/ToolOpsRegistry";

export enum ToolCallStatusIntEnum {
  Ok = 1,
  Error = 2,
  Blocked = 3,
}

export enum ToolCallStatusLabelEnum {
  Ok = "OK",
  Error = "Error",
  Blocked = "Blocked",
}

export const TOOL_CALL_STATUS_LABEL_MAP: Record<ToolCallStatusIntEnum, ToolCallStatusLabelEnum> = {
  [ToolCallStatusIntEnum.Ok]: ToolCallStatusLabelEnum.Ok,
  [ToolCallStatusIntEnum.Error]: ToolCallStatusLabelEnum.Error,
  [ToolCallStatusIntEnum.Blocked]: ToolCallStatusLabelEnum.Blocked,
};

// DEV_NOTE: tool_calls.error_code: why a host tool call didn't run or didn't succeed (M3-4). Codes, not text: the
// dashboard (M4-4) labels them. Never a host response, args or a token.
export enum ToolCallErrorCodeEnum {
  InvalidArgs = "invalid_args",
  LoopGuard = "loop_guard",
  BlockedByPolicy = "blocked_by_policy",
  PendingLimit = "pending_limit",
  TokenNeeded = "token_needed",
  TokenRejected = "token_rejected",
  HostRefused = "host_refused",
  HostFailed = "host_failed",
  HostUnknown = "host_unknown",
  NoChange = "no_change",
  ServerError = "server_error",
}

// Whole Tool Call Body — DB shape (status stored as integer)
// DEV_NOTE: id, companyId, conversationId, messageId and toolId are internal — NEVER sent to a client. encryptedArgs
// (+ iv, key version) hold the validated args (CompanyKeyProvider); null when the call never got valid args, and
// nulled when the chat is purged.
export const ZToolCall = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  conversationId: z.string(),
  messageId: z.string().nullable(),
  turnId: z.string(),
  toolId: z.string(),
  toolVersion: z.number().int(),
  encryptedArgs: ZBytes.nullable(),
  iv: ZBytes.nullable(),
  encryptionKeyVersion: z.number().int().nullable(),
  hasUntrustedContext: z.boolean(),
  status: z.enum(ToolCallStatusIntEnum),
  errorCode: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ToolCall = z.infer<typeof ZToolCall>;

// DEV_NOTE: Server-side only — one pinned tool version, loaded for a turn (ActionEngineRepo.loadTurnTools): Active,
// its connection Active, its ops loaded (loadToolOps) and its input_schema checkable. id is internal.
export interface RuntimeTool {
  id: string;
  name: string;
  version: number;
  description: string;
  risk: ToolDefinitionRiskIntEnum;
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum;
  approval: ToolDefinitionApprovalIntEnum;
  ops: ToolOps;
  connection: HostConnection;
}

// DEV_NOTE: The longest host response a read tool hands the model, in characters (JSON); the rest is cut with a marker
export const HOST_TOOL_OUTPUT_MAX_CHARS = 8_000;

// DEV_NOTE: What a host tool call returns (transcript, widget, model). Ok carries a read tool's host response (data);
// Committed / Failed / NeedsReview end an approved write; NoChange = the record already holds every value, so nothing
// was proposed; Proposed is never returned (a proposal parks the turn: Think's paused output). message is safe text
// for the model: no values, no host text. changeRequestId is the change request's public id.
export enum HostToolStatusEnum {
  Ok = "ok",
  Error = "error",
  Blocked = "blocked",
  NoChange = "no_change",
  Committed = "committed",
  Failed = "failed",
  NeedsReview = "needs_review",
}

export const ZHostToolOutput = z.object({
  status: z.enum(HostToolStatusEnum),
  message: z.string(),
  data: z.json().optional(),
  isTruncated: z.boolean().optional(),
  changeRequestId: z.string().optional(),
});
export type HostToolOutput = z.infer<typeof ZHostToolOutput>;
