import { z } from "zod";
import type { ApiResponse } from "../common";
import {
  CURRENT_TOOL_OPS_SCHEMA_VERSION,
  TOOL_OPS_REGISTRY,
  type ToolOps,
  type ToolOpsRegistry,
} from "./ToolOpsRegistry";

// A tool_definitions row's schema_version + ops, as read from the DB
export interface LoadToolOpsRequest {
  schemaVersion: number;
  ops: unknown;
}

export interface LoadToolOpsResponse extends ApiResponse {
  ops?: ToolOps;
  // True when the ops were stored at an older schema_version and upgraded on this read
  wasUpgraded?: boolean;
}

export interface NormalizeToolOpsResponse extends ApiResponse {
  ops?: ToolOps;
  schemaVersion?: number;
}

export interface UpgradeToolOpsResponse<TOps> extends ApiResponse {
  ops?: TOps;
  wasUpgraded?: boolean;
}

// DEV_NOTE: Walks the upgrader chain from schemaVersion to registry.currentVersion, one version at a time (each
// upgrader validates its own version first), then parses with registry.currentSchema. Never throws: an upgrader that
// throws is reported as a failure. Takes the registry as a parameter so tests can drive a multi-version chain; app
// code calls loadToolOps / normalizeToolOps.
export function upgradeToolOps<TCurrent extends z.ZodType>(
  registry: ToolOpsRegistry<TCurrent>,
  request: LoadToolOpsRequest,
): UpgradeToolOpsResponse<z.output<TCurrent>> {
  const { schemaVersion } = request;
  if (
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > registry.currentVersion
  ) {
    return {
      isSuccess: false,
      message: `Unknown tool ops schema version ${schemaVersion} (current is ${registry.currentVersion})`,
    };
  }

  let ops = request.ops;
  for (let version = schemaVersion; version < registry.currentVersion; version++) {
    const upgrader = registry.upgraders[version];
    if (!upgrader) {
      return {
        isSuccess: false,
        message: `No upgrader registered from tool ops schema version ${version}`,
      };
    }

    try {
      const upgraded = upgrader(ops);
      if (!upgraded.isSuccess) {
        return {
          isSuccess: false,
          message: `Invalid tool ops at schema version ${version}:\n${upgraded.message}`,
        };
      }
      ops = upgraded.ops;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        isSuccess: false,
        message: `Tool ops upgrade from schema version ${version} failed: ${reason}`,
      };
    }
  }

  const parsed = registry.currentSchema.safeParse(ops);
  if (!parsed.success) {
    return {
      isSuccess: false,
      message: `Invalid tool ops at schema version ${registry.currentVersion}:\n${z.prettifyError(parsed.error)}`,
    };
  }

  return {
    isSuccess: true,
    ops: parsed.data,
    wasUpgraded: schemaVersion < registry.currentVersion,
  };
}

// DEV_NOTE: Read path. Upgrades stored ops to the current version and validates them. The result is for the runtime
// only: never write it back (a stored version is immutable once active).
export function loadToolOps(request: LoadToolOpsRequest): LoadToolOpsResponse {
  const upgraded = upgradeToolOps(TOOL_OPS_REGISTRY, request);
  if (!upgraded.isSuccess || !upgraded.ops) {
    return { isSuccess: false, message: upgraded.message };
  }
  return { isSuccess: true, ops: upgraded.ops, wasUpgraded: upgraded.wasUpgraded };
}

// DEV_NOTE: Write path. Validates client ops against the current version (shapes and placeholder references) and
// returns the ops to store with the schema_version to store them at.
export function normalizeToolOps(ops: unknown): NormalizeToolOpsResponse {
  const normalized = upgradeToolOps(TOOL_OPS_REGISTRY, {
    schemaVersion: CURRENT_TOOL_OPS_SCHEMA_VERSION,
    ops,
  });
  if (!normalized.isSuccess || !normalized.ops) {
    return { isSuccess: false, message: normalized.message };
  }
  return { isSuccess: true, ops: normalized.ops, schemaVersion: CURRENT_TOOL_OPS_SCHEMA_VERSION };
}
