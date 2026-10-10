import type { NullableDALFields, PageDALRequest } from "../common";
import type { ToolDefinition, ToolDefinitionSortColumn } from "./ToolDefinitionsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId; ops arrive normalised by the Repo (normalizeToolOps) with their schemaVersion.
export type CreateToolDefinitionDALRequest = Pick<
  ToolDefinition,
  | "companyId"
  | "connectionId"
  | "name"
  | "version"
  | "description"
  | "risk"
  | "schemaVersion"
  | "inputSchema"
  | "callOp"
  | "readbackOp"
  | "inverseOp"
  | "idempotencyMode"
  | "approval"
  | "source"
  | "createdBy"
>;

// DEV_NOTE: isForUpdate locks the row for the rest of the transaction (SELECT … FOR UPDATE), so a state change (edit,
// status, delete) reads and writes the status with no other change in between
export type FindToolDefinitionDALRequest = Pick<ToolDefinition, "publicId" | "companyId"> & {
  isForUpdate: boolean;
};

// A connection named by the client, resolved inside the company
export type FindToolConnectionDALRequest = Pick<ToolDefinition, "companyId"> & {
  connectionPublicId: string;
};

// DEV_NOTE: Every version of one tool name. Used under lockToolDefinitionName, so the next version number and the
// one-Draft rule are read with no concurrent create in between.
export type FindToolDefinitionNameDALRequest = Pick<ToolDefinition, "companyId" | "name">;

export type GetToolDefinitionsCountDALRequest = Pick<ToolDefinition, "companyId"> &
  NullableDALFields<Pick<ToolDefinition, "name" | "status">>;

export type GetToolDefinitionsDALRequest = GetToolDefinitionsCountDALRequest &
  PageDALRequest & { sortColumn: ToolDefinitionSortColumn };

// DEV_NOTE: A Draft's editable fields; a null param is left as it is. ops is the whole ops unit with its
// schemaVersion (null = unchanged), since readback_op / inverse_op are nullable columns. The DAL updates only a Draft
// row, so a version activated since the Repo read it is never changed. updatedAt is set by the DAL.
export type ToolOpsColumns = Pick<
  ToolDefinition,
  "schemaVersion" | "inputSchema" | "callOp" | "readbackOp" | "inverseOp"
>;

export type UpdateToolDefinitionDraftDALRequest = Pick<ToolDefinition, "publicId" | "companyId"> &
  NullableDALFields<
    Pick<
      ToolDefinition,
      "connectionId" | "description" | "risk" | "idempotencyMode" | "approval" | "source"
    >
  > &
  Pick<ToolDefinition, "updatedBy"> & { ops: ToolOpsColumns | null };

export type SetToolDefinitionStatusDALRequest = Pick<
  ToolDefinition,
  "publicId" | "companyId" | "status" | "updatedBy"
>;

// DEV_NOTE: Deletes a Draft only
export type DeleteToolDefinitionDraftDALRequest = Pick<ToolDefinition, "publicId" | "companyId">;
