import type { ToolDefinitionFailureEnum, ToolDefinitionWithStatus } from "./ToolDefinitionsCommon";
import type { ToolOps } from "./ToolOpsRegistry";
import type { ApiResponse, TotalRecordsResponse } from "../common";

// DEV_NOTE: failure is set (with isSuccess false) when the request was refused for the tool's state or references;
// the route answers 409 or 400 (ToolDefinitionFailureEnum)
export interface ToolDefinitionStateResponse extends ApiResponse {
  failure?: ToolDefinitionFailureEnum;
}

export type CreateToolDefinitionApiResponse = ToolDefinitionMutationResponse;

// DEV_NOTE: Every write answers with the tool as it now is, or a failure
export interface ToolDefinitionMutationResponse extends ToolDefinitionStateResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export interface GetToolDefinitionApiResponse extends ApiResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export interface GetToolDefinitionsApiResponse extends ApiResponse {
  toolDefinitions?: ToolDefinitionWithStatus[];
}

export type GetToolDefinitionsCountApiResponse = TotalRecordsResponse;

export type UpdateToolDefinitionApiResponse = ToolDefinitionMutationResponse;

export type CreateToolDefinitionVersionApiResponse = ToolDefinitionMutationResponse;

export type SetToolDefinitionStatusApiResponse = ToolDefinitionMutationResponse;

export type DeleteToolDefinitionApiResponse = ToolDefinitionStateResponse;

// DEV_NOTE: Server-side only (ToolDefinitionsRepo steps, never a route response): a connection that can serve tool
// calls, or the refusal to answer with
export type ToolConnectionResult =
  | { isSuccess: true; connectionId: string }
  | { isSuccess: false; response: ToolDefinitionStateResponse };

// DEV_NOTE: Server-side only: client ops normalised at the current schema version and checked against the risk, or
// the refusal to answer with
export type ToolOpsResult =
  | { isSuccess: true; ops: ToolOps; schemaVersion: number }
  | { isSuccess: false; response: ToolDefinitionStateResponse };
