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
    | "id"
    | "status"
    | "adapterType"
    | "baseUrl"
    | "authType"
    | "authConfig"
    | "credentialScope"
    | "openapiUrl"
    | "openapiShaping"
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

// DEV_NOTE: One entry per write tool name that has a version past Draft: its newest such version's description
export interface WriteToolSummariesDALResponse extends ApiResponse {
  tools?: Pick<ToolDefinition, "name" | "description">[];
}

export interface ToolDefinitionOptionsDALResponse extends ApiResponse {
  options?: Pick<ToolDefinition, "name" | "version" | "description" | "risk">[];
}

// DEV_NOTE: M7-8. The rows a batch write touched, with what their audit rows need
export interface ToolDefinitionKeysDALResponse extends ApiResponse {
  toolDefinitions?: Pick<ToolDefinition, "id" | "publicId" | "name" | "version">[];
}

// DEV_NOTE: ADR 0009: the names of a connection's tools that follow its spec (a version of the name has an operation_id)
export interface ToolDefinitionNamesDALResponse extends ApiResponse {
  names?: string[];
}
