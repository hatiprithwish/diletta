import { z } from "zod";
import type { ApiResponse } from "../common";
import { applyPlatformDefaults, type ConfigSpec } from "./ConfigSpecDefaults";
import {
  CONFIG_SPEC_REGISTRY,
  CURRENT_CONFIG_SCHEMA_VERSION,
  type ConfigSpecBody,
  type ConfigSpecRegistry,
} from "./ConfigSpecRegistry";

// A chatbot_configs row's schema_version + body, as read from the DB
export interface LoadConfigSpecRequest {
  schemaVersion: number;
  body: unknown;
}

export interface LoadConfigSpecResponse extends ApiResponse {
  spec?: ConfigSpec;
  // True when the body was stored at an older schema_version and upgraded on this read
  wasUpgraded?: boolean;
}

export interface NormalizeConfigBodyResponse extends ApiResponse {
  body?: ConfigSpecBody;
  schemaVersion?: number;
}

export interface UpgradeConfigBodyResponse<TBody> extends ApiResponse {
  body?: TBody;
  wasUpgraded?: boolean;
}

// DEV_NOTE: Walks the upgrader chain from schemaVersion to registry.currentVersion, one version at a time (each
// upgrader validates its own version first), then parses with registry.currentSchema. Never throws: an
// upgrader that throws is reported as a failure. Takes the registry as a parameter so tests can drive a
// multi-version chain; app code calls loadConfigSpec / normalizeConfigBody.
export function upgradeConfigBody<TCurrent extends z.ZodType>(
  registry: ConfigSpecRegistry<TCurrent>,
  request: LoadConfigSpecRequest,
): UpgradeConfigBodyResponse<z.output<TCurrent>> {
  const { schemaVersion } = request;
  if (
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > registry.currentVersion
  ) {
    return {
      isSuccess: false,
      message: `Unknown config schema version ${schemaVersion} (current is ${registry.currentVersion})`,
    };
  }

  let body = request.body;
  for (let version = schemaVersion; version < registry.currentVersion; version++) {
    const upgrader = registry.upgraders[version];
    if (!upgrader) {
      return {
        isSuccess: false,
        message: `No upgrader registered from config schema version ${version}`,
      };
    }

    try {
      const upgraded = upgrader(body);
      if (!upgraded.isSuccess) {
        return {
          isSuccess: false,
          message: `Invalid config body at schema version ${version}:\n${upgraded.message}`,
        };
      }
      body = upgraded.body;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        isSuccess: false,
        message: `Config upgrade from schema version ${version} failed: ${reason}`,
      };
    }
  }

  const parsed = registry.currentSchema.safeParse(body);
  if (!parsed.success) {
    return {
      isSuccess: false,
      message: `Invalid config body at schema version ${registry.currentVersion}:\n${z.prettifyError(parsed.error)}`,
    };
  }

  return {
    isSuccess: true,
    body: parsed.data,
    wasUpgraded: schemaVersion < registry.currentVersion,
  };
}

// DEV_NOTE: Read path. Upgrades a stored body to the current version, validates it, then fills in today's
// platform defaults. The result is for the runtime only: never write it back (it would freeze the defaults).
export function loadConfigSpec(request: LoadConfigSpecRequest): LoadConfigSpecResponse {
  const upgraded = upgradeConfigBody(CONFIG_SPEC_REGISTRY, request);
  if (!upgraded.isSuccess || !upgraded.body) {
    return { isSuccess: false, message: upgraded.message };
  }

  return {
    isSuccess: true,
    spec: applyPlatformDefaults(upgraded.body),
    wasUpgraded: upgraded.wasUpgraded,
  };
}

// DEV_NOTE: Write path. Validates a client body against the current version and returns the normalised body to
// store (text trimmed, omitted fields still omitted, no platform defaults) with the schema_version to store it
// at. body_hash is computed over this returned body, serialised with sorted keys (jsonb doesn't keep key
// order), so it changes only when the company's own config does, never when a platform default does.
export function normalizeConfigBody(body: unknown): NormalizeConfigBodyResponse {
  const normalized = upgradeConfigBody(CONFIG_SPEC_REGISTRY, {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    body,
  });
  if (!normalized.isSuccess || !normalized.body) {
    return { isSuccess: false, message: normalized.message };
  }

  return {
    isSuccess: true,
    body: normalized.body,
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
  };
}
