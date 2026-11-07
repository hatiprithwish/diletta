import { z } from "zod";

// DEV_NOTE: Tool contract sync (ADR 0009): a tool's input_schema follows its company's OpenAPI spec. The spec is
// fetched through @app/adapter, converted here (pure), compared, and a change becomes a new tool version.

// A spec larger than this isn't read (eRegister's is ~300 KB)
export const TOOL_CONTRACT_MAX_BYTES = 4 * 1_048_576;
export const TOOL_CONTRACT_SYNC_MAX_CONNECTIONS = 10;
// A connection synced less than this long ago is skipped by the hourly sweep (an operator's sync isn't)
export const TOOL_CONTRACT_SYNC_MIN_INTERVAL_MS = 50 * 60_000;
export const TOOL_CONTRACT_URL_MAX_CHARS = 2_048;
// The most components one tool's input_schema may take from the spec, and the most changes a summary lists
export const TOOL_CONTRACT_MAX_DEFS = 600;
export const TOOL_CONTRACT_MAX_CHANGE_NOTES = 20;

// Why a connection's last sync failed (company_connections.openapi_failure; null = it didn't)
export enum ToolContractSyncFailureIntEnum {
  FetchFailed = 1,
  NotOpenApi = 2,
  OperationMissing = 3,
  SchemaUnenforceable = 4,
  ServerError = 5,
}

export enum ToolContractSyncFailureLabelEnum {
  FetchFailed = "Couldn't fetch the spec",
  NotOpenApi = "Not a JSON OpenAPI 3 spec",
  OperationMissing = "A tool's operation is gone",
  SchemaUnenforceable = "A schema can't be checked",
  ServerError = "Server error",
}

export const TOOL_CONTRACT_SYNC_FAILURE_LABEL_MAP: Record<
  ToolContractSyncFailureIntEnum,
  ToolContractSyncFailureLabelEnum
> = {
  [ToolContractSyncFailureIntEnum.FetchFailed]: ToolContractSyncFailureLabelEnum.FetchFailed,
  [ToolContractSyncFailureIntEnum.NotOpenApi]: ToolContractSyncFailureLabelEnum.NotOpenApi,
  [ToolContractSyncFailureIntEnum.OperationMissing]:
    ToolContractSyncFailureLabelEnum.OperationMissing,
  [ToolContractSyncFailureIntEnum.SchemaUnenforceable]:
    ToolContractSyncFailureLabelEnum.SchemaUnenforceable,
  [ToolContractSyncFailureIntEnum.ServerError]: ToolContractSyncFailureLabelEnum.ServerError,
};

// How a tool's new schema differs from its current one
export enum ToolSchemaChangeEnum {
  None = "none",
  Additive = "additive",
  Breaking = "breaking",
}

export const TOOL_SCHEMA_CHANGE_LABEL_MAP: Record<ToolSchemaChangeEnum, string> = {
  [ToolSchemaChangeEnum.None]: "No change",
  [ToolSchemaChangeEnum.Additive]: "Adds only",
  [ToolSchemaChangeEnum.Breaking]: "Breaking",
};

// DEV_NOTE: Per-connection shaping (company_connections.openapi_shaping): turns a host's contract into args a model
// can fill. isDefaultRequired: a field with a default is required (so a read-back compares equal to what the host
// stored). replaceComponents: a named component replaced by this schema (one large shared shape kept out of the
// context; the model reads it from a tool instead).
export const ZOpenApiShaping = z.strictObject({
  isDefaultRequired: z.boolean(),
  replaceComponents: z.record(z.string().min(1).max(200), z.record(z.string(), z.json())),
});
export type OpenApiShaping = z.infer<typeof ZOpenApiShaping>;

export const DEFAULT_OPENAPI_SHAPING: OpenApiShaping = {
  isDefaultRequired: false,
  replaceComponents: {},
};

// An https URL with no credentials or fragment, like a connection's base_url
export const ZToolContractUrl = z
  .url({ protocol: /^https$/ })
  .max(TOOL_CONTRACT_URL_MAX_CHARS)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.username === "" && url.password === "" && url.hash === "";
    },
    { message: "The spec URL has no credentials or fragment" },
  );
