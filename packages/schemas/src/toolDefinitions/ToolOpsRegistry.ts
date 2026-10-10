import { z } from "zod";
import { ZToolOpsV1 } from "./ToolOpsV1";

// DEV_NOTE: tool_definitions.schema_version says which schema parses a row's ops (input_schema, call_op, readback_op,
// inverse_op, as one unit). New rows are always written at the registry's currentVersion; older rows are upgraded on
// read (loadToolOps), never rewritten in place: a version is immutable once active. The version, the current schema
// and the upgraders are one unit, so a bump can't leave one behind.
// Bumping the version (pattern rule 3.12): add ZToolOpsV<n+1>, set currentVersion / currentSchema below, register
// defineToolOpsUpgrader(ZToolOpsV<n>, …) under key n, and add an upgrade test.
export interface ToolOpsRegistry<TCurrent extends z.ZodType = z.ZodType> {
  currentVersion: number;
  // Parses stored ops at currentVersion
  currentSchema: TCurrent;
  // Keyed by the version ops are upgraded FROM; one entry for every version below currentVersion
  upgraders: Record<number, ToolOpsUpgrader>;
}

export type ToolOpsUpgradeResult =
  | { isSuccess: true; ops: unknown }
  | { isSuccess: false; message: string };

// Validates ops against the schema of the version they were stored at, then returns the next version's ops
export type ToolOpsUpgrader = (ops: unknown) => ToolOpsUpgradeResult;

// DEV_NOTE: The upgrade function receives the parsed stored ops of its own version, typed by that version's schema, so
// no upgrader handles invalid old ops.
export function defineToolOpsUpgrader<TFrom extends z.ZodType>(
  fromSchema: TFrom,
  upgrade: (ops: z.output<TFrom>) => unknown,
): ToolOpsUpgrader {
  return (ops) => {
    const parsed = fromSchema.safeParse(ops);
    if (!parsed.success) {
      return { isSuccess: false, message: z.prettifyError(parsed.error) };
    }
    return { isSuccess: true, ops: upgrade(parsed.data) };
  };
}

export const TOOL_OPS_REGISTRY: ToolOpsRegistry<typeof ZToolOpsV1> = {
  currentVersion: 1,
  currentSchema: ZToolOpsV1,
  upgraders: {},
};

export const CURRENT_TOOL_OPS_SCHEMA_VERSION = TOOL_OPS_REGISTRY.currentVersion;

// The ops at the current version: what a client sends (Input) and what is stored
export const ZToolOps = TOOL_OPS_REGISTRY.currentSchema;
export type ToolOpsInput = z.input<typeof ZToolOps>;
export type ToolOps = z.output<typeof ZToolOps>;
export type ToolCallOp = ToolOps["callOp"];
export type ToolReadbackOp = NonNullable<ToolOps["readbackOp"]>;
export type ToolInverseOp = NonNullable<ToolOps["inverseOp"]>;
