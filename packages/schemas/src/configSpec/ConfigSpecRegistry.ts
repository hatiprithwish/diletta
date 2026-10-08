import { z } from "zod";
import { ZConfigSpecV1, type ConfigSpecV1, type ConfigSpecV1Input } from "./ConfigSpecV1";

// DEV_NOTE: chatbot_configs.schema_version says which spec parses a row's body. New rows are always written at
// CURRENT_CONFIG_SCHEMA_VERSION; older rows are upgraded on read (loadConfigSpec), never rewritten in place.
// Bumping the version (pattern rule 3.12): add ZConfigSpecV<n+1>, point the aliases below at it, register
// defineConfigSpecUpgrader(ZConfigSpecV<n>, …) under key n, add an upgrade test, run
// `pnpm --filter @app/schemas schema:export`.
export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

export const ZConfigSpec = ZConfigSpecV1;
export type ConfigSpecInput = ConfigSpecV1Input;
export type ConfigSpec = ConfigSpecV1;

export type ConfigSpecUpgradeResult =
  | { isSuccess: true; body: unknown }
  | { isSuccess: false; message: string };

// Validates a body against the spec of the version it was stored at, then returns the next version's input
export type ConfigSpecUpgrader = (body: unknown) => ConfigSpecUpgradeResult;

export interface ConfigSpecRegistry {
  currentVersion: number;
  // Keyed by the version a body is upgraded FROM; one entry for every version below currentVersion
  upgraders: Record<number, ConfigSpecUpgrader>;
}

// DEV_NOTE: The upgrade function receives the parsed (defaults-filled) body of its own version, typed by that
// version's schema, so no upgrader ever handles an invalid old body.
export function defineConfigSpecUpgrader<TFrom extends z.ZodType>(
  fromSchema: TFrom,
  upgrade: (body: z.output<TFrom>) => unknown,
): ConfigSpecUpgrader {
  return (body) => {
    const parsed = fromSchema.safeParse(body);
    if (!parsed.success) {
      return { isSuccess: false, message: z.prettifyError(parsed.error) };
    }
    return { isSuccess: true, body: upgrade(parsed.data) };
  };
}

export const CONFIG_SPEC_REGISTRY: ConfigSpecRegistry = {
  currentVersion: CURRENT_CONFIG_SCHEMA_VERSION,
  upgraders: {},
};
