import type { ToolDefinitionFailureEnum, ToolDefinitionWithStatus } from "./ToolDefinitionsCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";

// DEV_NOTE: failure is set (with isSuccess false) when the request was refused for the tool's state or references;
// the route answers 409 or 400 (ToolDefinitionFailureEnum)
export interface ToolDefinitionStateResponse extends ApiResponse {
  failure?: ToolDefinitionFailureEnum;
}

export interface CreateToolDefinitionApiResponse extends ToolDefinitionStateResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export interface GetToolDefinitionApiResponse extends ApiResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export interface GetToolDefinitionsApiResponse extends ApiResponse {
  toolDefinitions?: ToolDefinitionWithStatus[];
}

export type GetToolDefinitionsCountApiResponse = TotalRecordsResponse;

export interface UpdateToolDefinitionApiResponse extends ToolDefinitionStateResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export interface CreateToolDefinitionVersionApiResponse extends ToolDefinitionStateResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export interface SetToolDefinitionStatusApiResponse extends ToolDefinitionStateResponse {
  toolDefinition?: ToolDefinitionWithStatus;
}

export type DeleteToolDefinitionApiResponse = ToolDefinitionStateResponse;
