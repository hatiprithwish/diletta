import type { ToolDefinitionRow } from "./ToolDefinitionsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids, ints, jsonb ops). The Repo maps them to API responses.
export interface ToolDefinitionDALResponse extends ApiResponse {
  toolDefinition?: ToolDefinitionRow;
}

export interface ToolDefinitionsDALResponse extends ApiResponse {
  toolDefinitions?: ToolDefinitionRow[];
}

// isSuccess with no connectionId = not one of the company's connections
export interface ToolConnectionDALResponse extends ApiResponse {
  connectionId?: string;
}

// Every version of one tool name: the highest version (0 = none) and whether one of them is a Draft
export interface ToolDefinitionNameDALResponse extends ApiResponse {
  latestVersion?: number;
  hasDraft?: boolean;
}
