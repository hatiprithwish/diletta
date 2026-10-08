import { z } from "zod";
import type { ApiResponse } from "../common";
import {
  CONFIG_SPEC_REGISTRY,
  ZConfigSpec,
  type ConfigSpec,
  type ConfigSpecRegistry,
} from "./ConfigSpecRegistry";

// A chatbot_configs row's schema_version + body, as read from the DB or about to be written
export interface LoadConfigSpecRequest {
  schemaVersion: number;
  body: unknown;
}

export interface LoadConfigSpecResponse extends ApiResponse {
  spec?: ConfigSpec;
  // True when the body was stored at an older schema_version and upgraded on this read
  wasUpgraded?: boolean;
}

export interface UpgradeConfigBodyResponse extends ApiResponse {
  body?: unknown;
  wasUpgraded?: boolean;
}

// DEV_NOTE: Walks the upgrader chain from schemaVersion to registry.currentVersion, one version at a time. Each
// upgrader validates its own version first. Never throws: an upgrader that throws is reported as a failure.
// Takes the registry as a parameter so tests can drive a multi-version chain; app code calls loadConfigSpec.
export function upgradeConfigBody(
  registry: ConfigSpecRegistry,
  request: LoadConfigSpecRequest,
): UpgradeConfigBodyResponse {
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

  return { isSuccess: true, body, wasUpgraded: schemaVersion < registry.currentVersion };
}

// DEV_NOTE: The one entry point for reading or writing a config body. Reads pass the row's schema_version;
// writes pass CURRENT_CONFIG_SCHEMA_VERSION and store the body with that version. The returned spec has every
// platform default filled in.
export function loadConfigSpec(request: LoadConfigSpecRequest): LoadConfigSpecResponse {
  const upgraded = upgradeConfigBody(CONFIG_SPEC_REGISTRY, request);
  if (!upgraded.isSuccess) {
    return { isSuccess: false, message: upgraded.message };
  }

  const parsed = ZConfigSpec.safeParse(upgraded.body);
  if (!parsed.success) {
    return {
      isSuccess: false,
      message: `Invalid config body at schema version ${CONFIG_SPEC_REGISTRY.currentVersion}:\n${z.prettifyError(parsed.error)}`,
    };
  }

  return { isSuccess: true, spec: parsed.data, wasUpgraded: upgraded.wasUpgraded };
}
