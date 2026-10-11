import { z } from "zod";
import { SEARCH_HELP_DOCS_TOOL_NAME } from "../knowledgeSearch/KnowledgeSearchCommon";
import { ZToolOps, type ToolInverseOp, type ToolOps, type ToolReadbackOp } from "./ToolOpsRegistry";
import {
  ToolOpPlaceholderRootEnum,
  collectTemplateStrings,
  findToolOpPlaceholders,
} from "./ToolOpPlaceholders";

export enum ToolDefinitionRiskIntEnum {
  Read = 1,
  Write = 2,
  Destructive = 3,
}

export enum ToolDefinitionRiskLabelEnum {
  Read = "Read",
  Write = "Write",
  Destructive = "Destructive",
}

export const TOOL_DEFINITION_RISK_LABEL_MAP: Record<
  ToolDefinitionRiskIntEnum,
  ToolDefinitionRiskLabelEnum
> = {
  [ToolDefinitionRiskIntEnum.Read]: ToolDefinitionRiskLabelEnum.Read,
  [ToolDefinitionRiskIntEnum.Write]: ToolDefinitionRiskLabelEnum.Write,
  [ToolDefinitionRiskIntEnum.Destructive]: ToolDefinitionRiskLabelEnum.Destructive,
};

export enum ToolDefinitionIdempotencyModeIntEnum {
  Native = 1,
  Emulated = 2,
  None = 3,
}

export enum ToolDefinitionIdempotencyModeLabelEnum {
  Native = "Native",
  Emulated = "Emulated",
  None = "None",
}

export const TOOL_DEFINITION_IDEMPOTENCY_MODE_LABEL_MAP: Record<
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionIdempotencyModeLabelEnum
> = {
  [ToolDefinitionIdempotencyModeIntEnum.Native]: ToolDefinitionIdempotencyModeLabelEnum.Native,
  [ToolDefinitionIdempotencyModeIntEnum.Emulated]: ToolDefinitionIdempotencyModeLabelEnum.Emulated,
  [ToolDefinitionIdempotencyModeIntEnum.None]: ToolDefinitionIdempotencyModeLabelEnum.None,
};

export enum ToolDefinitionApprovalIntEnum {
  Always = 1,
  Policy = 2,
  Never = 3,
}

export enum ToolDefinitionApprovalLabelEnum {
  Always = "Always",
  Policy = "Policy",
  Never = "Never",
}

export const TOOL_DEFINITION_APPROVAL_LABEL_MAP: Record<
  ToolDefinitionApprovalIntEnum,
  ToolDefinitionApprovalLabelEnum
> = {
  [ToolDefinitionApprovalIntEnum.Always]: ToolDefinitionApprovalLabelEnum.Always,
  [ToolDefinitionApprovalIntEnum.Policy]: ToolDefinitionApprovalLabelEnum.Policy,
  [ToolDefinitionApprovalIntEnum.Never]: ToolDefinitionApprovalLabelEnum.Never,
};

export enum ToolDefinitionSourceIntEnum {
  OpenApi = 1,
  Manual = 2,
}

export enum ToolDefinitionSourceLabelEnum {
  OpenApi = "OpenAPI",
  Manual = "Manual",
}

export const TOOL_DEFINITION_SOURCE_LABEL_MAP: Record<
  ToolDefinitionSourceIntEnum,
  ToolDefinitionSourceLabelEnum
> = {
  [ToolDefinitionSourceIntEnum.OpenApi]: ToolDefinitionSourceLabelEnum.OpenApi,
  [ToolDefinitionSourceIntEnum.Manual]: ToolDefinitionSourceLabelEnum.Manual,
};

export enum ToolDefinitionStatusIntEnum {
  Draft = 1,
  Active = 2,
  Disabled = 3,
}

export enum ToolDefinitionStatusLabelEnum {
  Draft = "Draft",
  Active = "Active",
  Disabled = "Disabled",
}

export const TOOL_DEFINITION_STATUS_LABEL_MAP: Record<
  ToolDefinitionStatusIntEnum,
  ToolDefinitionStatusLabelEnum
> = {
  [ToolDefinitionStatusIntEnum.Draft]: ToolDefinitionStatusLabelEnum.Draft,
  [ToolDefinitionStatusIntEnum.Active]: ToolDefinitionStatusLabelEnum.Active,
  [ToolDefinitionStatusIntEnum.Disabled]: ToolDefinitionStatusLabelEnum.Disabled,
};

export enum ToolDefinitionSortColumn {
  CreatedAt = "createdAt",
  Name = "name",
}

export const ZToolDefinitionSortColumn = z.enum(ToolDefinitionSortColumn);

// DEV_NOTE: Why a tool definition request was refused for its state or its references, not its shape. The HTTP
// status for each is TOOL_DEFINITION_FAILURE_HTTP_STATUS_MAP.
//   NotDraft: only a Draft version is edited or deleted; an active or disabled version is immutable (a config may pin
//     it). Change it through a new version.
//   DraftExists: a tool name has at most one Draft at a time; edit that one.
//   NameTaken: create starts a new tool at version 1; a name already in use is refused (create a new version of it).
//   InvalidTransition: the status change isn't allowed from the current status (Draft → Active, Active ↔ Disabled).
//   InvalidOps: the ops don't parse at the current schema version, or don't fit the risk (a read tool has no readback
//     or inverse op, every write has a readback op).
//   ConnectionNotFound: the connection isn't one of the company's.
//   ConnectionUnavailable: the connection can't serve a tool call: it is Disabled, not a REST connection with a
//     base_url (op paths are relative to it), or its auth type / auth_config has no AuthStrategy (getAuthConfigIssue).
export enum ToolDefinitionFailureEnum {
  NotDraft = "NotDraft",
  DraftExists = "DraftExists",
  NameTaken = "NameTaken",
  InvalidTransition = "InvalidTransition",
  InvalidOps = "InvalidOps",
  ConnectionNotFound = "ConnectionNotFound",
  ConnectionUnavailable = "ConnectionUnavailable",
}

// DEV_NOTE: 409 = the tool's state refused it; 400 = the request's ops or connection can't be used
export const TOOL_DEFINITION_FAILURE_HTTP_STATUS_MAP: Record<ToolDefinitionFailureEnum, 400 | 409> =
  {
    [ToolDefinitionFailureEnum.NotDraft]: 409,
    [ToolDefinitionFailureEnum.DraftExists]: 409,
    [ToolDefinitionFailureEnum.NameTaken]: 409,
    [ToolDefinitionFailureEnum.InvalidTransition]: 409,
    [ToolDefinitionFailureEnum.InvalidOps]: 400,
    [ToolDefinitionFailureEnum.ConnectionNotFound]: 400,
    [ToolDefinitionFailureEnum.ConnectionUnavailable]: 400,
  };

// DEV_NOTE: The name the model calls the tool by: provider tool-name rules (letters, digits, _ and -, at most 64,
// starting with a letter). The platform's own tool name is reserved, so a host tool can never shadow it.
export const ZToolDefinitionName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "Invalid tool name")
  .refine((name) => name !== SEARCH_HELP_DOCS_TOOL_NAME, { message: "Reserved tool name" });

// DEV_NOTE: Whether an op reads the call_op response anywhere ({result.*} in its path, query or body). A readback op
// that does has no read-before (M3-4): the record it reads exists only after the call (a create's new id).
export function readsCallResult(op: ToolReadbackOp | ToolInverseOp): boolean {
  const strings: { text: string; path: (string | number)[] }[] = [];
  collectTemplateStrings(op.path, [], strings);
  collectTemplateStrings(op.query, [], strings);
  if ("bodyMap" in op) collectTemplateStrings(op.bodyMap, [], strings);
  return strings.some(({ text }) =>
    findToolOpPlaceholders(text).some(
      (placeholder) => placeholder.root === ToolOpPlaceholderRootEnum.Result,
    ),
  );
}

// DEV_NOTE: The risk rule CHK_tool_definitions_readback_op enforces, plus: a read tool has nothing to undo, and an
// Emulated write never reads {result.*} after the call. Emulated idempotency (@app/adapter) proves a write landed by
// reading it back with the args alone, and a commit found that way has no call response for a read-after or an undo
// to read. A read tool's idempotency mode is unused (reads are always safe to retry). Checked on the request and
// again by the Repo on the merged row of an edit.
export function getToolRiskOpsIssue(
  risk: ToolDefinitionRiskIntEnum,
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum,
  ops: Pick<ToolOps, "readbackOp" | "inverseOp">,
): string | null {
  const isRead = risk === ToolDefinitionRiskIntEnum.Read;
  if (isRead && ops.readbackOp !== null) return "A read tool has no readback op";
  if (isRead && ops.inverseOp !== null) return "A read tool has no inverse op";
  if (!isRead && ops.readbackOp === null) return "A write tool needs a readback op";
  if (!isRead && idempotencyMode === ToolDefinitionIdempotencyModeIntEnum.Emulated) {
    if (ops.readbackOp && readsCallResult(ops.readbackOp)) {
      return "An emulated-idempotency tool's readback op can't read {result.*}";
    }
    if (ops.inverseOp && readsCallResult(ops.inverseOp)) {
      return "An emulated-idempotency tool's inverse op can't read {result.*}";
    }
  }
  return null;
}

// Create Tool Definition Body (version 1, Draft)
// DEV_NOTE: The connection is named by its public id; the DAL resolves it inside the company
export const ZToolDefinitionBase = z.object({
  connectionPublicId: z.string().trim().min(1).max(64),
  name: ZToolDefinitionName,
  description: z.string().trim().min(1).max(2_000),
  risk: z.enum(ToolDefinitionRiskIntEnum),
  idempotencyMode: z.enum(ToolDefinitionIdempotencyModeIntEnum),
  approval: z.enum(ToolDefinitionApprovalIntEnum),
  source: z.enum(ToolDefinitionSourceIntEnum),
  ops: ZToolOps,
});
export type ToolDefinitionBase = z.infer<typeof ZToolDefinitionBase>;

// Whole Tool Definition Body — DB shape (enums stored as integers, ops as jsonb columns)
// DEV_NOTE: id, companyId, connectionId, createdBy and updatedBy are internal bigint ids — used by DAL/Repo only,
// NEVER sent to a client. The op columns are typed unknown: only loadToolOps turns them into ops.
export const ZToolDefinition = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  connectionId: z.string(),
  name: z.string(),
  version: z.number().int(),
  description: z.string(),
  risk: z.enum(ToolDefinitionRiskIntEnum),
  schemaVersion: z.number().int(),
  inputSchema: z.unknown(),
  callOp: z.unknown(),
  readbackOp: z.unknown(),
  inverseOp: z.unknown(),
  idempotencyMode: z.enum(ToolDefinitionIdempotencyModeIntEnum),
  approval: z.enum(ToolDefinitionApprovalIntEnum),
  source: z.enum(ToolDefinitionSourceIntEnum),
  status: z.enum(ToolDefinitionStatusIntEnum),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ToolDefinition = z.infer<typeof ZToolDefinition>;

// DEV_NOTE: A row as the DAL reads it: joined to its connection for the public id (null when the connection is gone;
// there are no DB foreign keys)
export type ToolDefinitionRow = ToolDefinition & { connectionPublicId: string | null };

// API response shape — includes both ints and labels; internal ids are structurally omitted, publicId is
// client-facing. ops are the loaded ops (upgraded to the current schema version), schemaVersion the stored one.
export type ToolDefinitionWithStatus = Omit<
  ToolDefinitionRow,
  | "id"
  | "companyId"
  | "connectionId"
  | "createdBy"
  | "updatedBy"
  | "inputSchema"
  | "callOp"
  | "readbackOp"
  | "inverseOp"
> & {
  ops: ToolOps;
  toolDefinitionStatus: ToolDefinitionStatusIntEnum;
  toolDefinitionStatusLabel: ToolDefinitionStatusLabelEnum;
  riskLabel: ToolDefinitionRiskLabelEnum;
  idempotencyModeLabel: ToolDefinitionIdempotencyModeLabelEnum;
  approvalLabel: ToolDefinitionApprovalLabelEnum;
  sourceLabel: ToolDefinitionSourceLabelEnum;
};
