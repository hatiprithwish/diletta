import { z } from "zod";
import { ZConfigSpecV1 } from "./ConfigSpecV1";

// DEV_NOTE: chatbot_configs.schema_version says which spec parses a row's body. New rows are always written at
// the registry's currentVersion; older rows are upgraded on read (loadConfigSpec), never rewritten in place.
// The version, the current schema and the upgraders are one unit, so a bump can't leave one behind.
// Bumping the version (pattern rule 3.12): add ZConfigSpecV<n+1>, set currentVersion / currentSchema below,
// register defineConfigSpecUpgrader(ZConfigSpecV<n>, …) under key n, add an upgrade test, update
// ConfigSpecDefaults.ts for any new defaulted field, run `pnpm --filter @app/schemas schema:export`.
export interface ConfigSpecRegistry<TCurrent extends z.ZodType = z.ZodType> {
  currentVersion: number;
  // Parses a stored body at currentVersion
  currentSchema: TCurrent;
  // Keyed by the version a body is upgraded FROM; one entry for every version below currentVersion
  upgraders: Record<number, ConfigSpecUpgrader>;
}

export type ConfigSpecUpgradeResult =
  | { isSuccess: true; body: unknown }
  | { isSuccess: false; message: string };

// Validates a body against the spec of the version it was stored at, then returns the next version's body
export type ConfigSpecUpgrader = (body: unknown) => ConfigSpecUpgradeResult;

// DEV_NOTE: The upgrade function receives the parsed stored body of its own version, typed by that version's
// schema, so no upgrader handles an invalid old body. Stored bodies carry no platform defaults (an omitted field
// stays omitted), so an upgrader never turns an old default into a company value; return omitted fields omitted.
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

export const CONFIG_SPEC_REGISTRY: ConfigSpecRegistry<typeof ZConfigSpecV1> = {
  currentVersion: 1,
  currentSchema: ZConfigSpecV1,
  upgraders: {},
};

export const CURRENT_CONFIG_SCHEMA_VERSION = CONFIG_SPEC_REGISTRY.currentVersion;

// The stored body at the current version: what a client sends (Input) and what is stored (trimmed, no defaults)
export const ZConfigSpecBody = CONFIG_SPEC_REGISTRY.currentSchema;
export type ConfigSpecBodyInput = z.input<typeof ZConfigSpecBody>;
export type ConfigSpecBody = z.output<typeof ZConfigSpecBody>;
