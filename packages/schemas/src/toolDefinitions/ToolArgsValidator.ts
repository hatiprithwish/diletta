import { z } from "zod";
import type { ApiResponse } from "../common";
import type { ToolOps } from "./ToolOpsRegistry";

// DEV_NOTE: The model's tool args are checked against the tool's input_schema (JSON Schema) before renderToolOp sees
// them (M3-4): types, enums, formats, bounds and required, which the renderer doesn't check (it drops a missing arg's
// key). The schema is turned into a Zod schema with zod's own fromJSONSchema; a schema it can't convert (if/then/else,
// not, external $ref…) has no validator, so the tool is refused on save and left out of a turn (never run unchecked).
// Neither function throws.

export type ToolInputSchema = ToolOps["inputSchema"];

export interface BuildToolArgsValidatorResponse extends ApiResponse {
  validator?: z.ZodType;
}

export interface ValidateToolArgsResponse extends ApiResponse {
  // Only the input_schema's own properties: an extra key the model sent is dropped, so nothing undeclared is stored
  args?: Record<string, unknown>;
  // Where the args failed (path and reason, never the value), for the model to fix its call
  issues?: string[];
}

export function buildToolArgsValidator(
  inputSchema: ToolInputSchema,
): BuildToolArgsValidatorResponse {
  try {
    const validator = z.fromJSONSchema(inputSchema, { defaultTarget: "draft-2020-12" });
    return { isSuccess: true, message: "Validator built", validator };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unsupported keyword";
    return { isSuccess: false, message: `input_schema can't be checked: ${reason}` };
  }
}

// DEV_NOTE: Null when the input_schema can be checked at runtime; else the reason, for a save or an activation
export function getToolInputSchemaIssue(inputSchema: ToolInputSchema): string | null {
  const built = buildToolArgsValidator(inputSchema);
  return built.isSuccess ? null : (built.message ?? "input_schema can't be checked");
}

export function validateToolArgs(
  validator: z.ZodType,
  inputSchema: ToolInputSchema,
  args: unknown,
): ValidateToolArgsResponse {
  const parsed = validator.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(args)";
      return `${path}: ${issue.message}`;
    });
    return { isSuccess: false, message: "Tool args don't match the input schema", issues };
  }
  if (parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return {
      isSuccess: false,
      message: "Tool args must be an object",
      issues: ["(args): not an object"],
    };
  }

  const data: Record<string, unknown> = Object.fromEntries(Object.entries(parsed.data));
  const declared = Object.keys(inputSchema.properties).filter(
    (name) => Object.hasOwn(data, name) && data[name] !== undefined,
  );
  return {
    isSuccess: true,
    message: "Tool args valid",
    args: Object.fromEntries(declared.map((name) => [name, data[name]])),
  };
}
