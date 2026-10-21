import type { ToolDefinition, ToolDefinitionRow } from "./ToolDefinitionsCommon";
import type { ApiResponse } from "../common";
import type { CompanyConnection } from "../companyConnections";

// DAL results carry the raw DB row (internal ids, ints, jsonb ops). The Repo maps them to API responses.
export interface ToolDefinitionDALResponse extends ApiResponse {
  toolDefinition?: ToolDefinitionRow;
}

export interface ToolDefinitionsDALResponse extends ApiResponse {
  toolDefinitions?: ToolDefinitionRow[];
}

// isSuccess with no connection = not one of the company's connections
export interface ToolConnectionDALResponse extends ApiResponse {
  connection?: Pick<
    CompanyConnection,
    "id" | "status" | "adapterType" | "baseUrl" | "authType" | "authConfig" | "credentialScope"
  >;
}

// Every version of one tool name: the highest version (0 = none) and whether one of them is a Draft
export interface ToolDefinitionNameDALResponse extends ApiResponse {
  latestVersion?: number;
  hasDraft?: boolean;
}

// DEV_NOTE: A tool version with the connection fields a host call needs (M3-4). Left join: a connection that is gone
// leaves connection null, and the Repo leaves the tool out.
export type ToolDefinitionWithConnectionRow = ToolDefinition & {
  connection: Pick<
    CompanyConnection,
    "status" | "adapterType" | "baseUrl" | "authType" | "authConfig" | "credentialScope"
  > | null;
};

export interface ToolDefinitionsWithConnectionDALResponse extends ApiResponse {
  toolDefinitions?: ToolDefinitionWithConnectionRow[];
}

export interface ToolDefinitionWithConnectionDALResponse extends ApiResponse {
  toolDefinition?: ToolDefinitionWithConnectionRow;
}
