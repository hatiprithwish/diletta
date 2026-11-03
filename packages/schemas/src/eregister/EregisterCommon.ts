import type { ToolDefinitionSeed } from "../toolDefinitions/ToolDefinitionsCommon";
import type { ToolOpsV1Input } from "../toolDefinitions/ToolOpsV1";
import { EREGISTER_INPUT_SCHEMAS, type EregisterInputSchemaName } from "./EregisterInputSchemas";

// DEV_NOTE: eRegister, the first customer host (M7, docs/runbooks/eregister.md). Its connection's base_url is
// {eRegister API}/api/p/, so every tool path below starts at /companies/{companyId}/…. eRegister has no OpenAPI spec:
// the tools are written here by hand (M7-2) over eRegister's Zod request schemas, whose JSON Schema is generated into
// EregisterInputSchemas.ts (scripts/exportEregisterInputSchemas.ts).
export type EregisterToolDefinition = ToolDefinitionSeed;

// DEV_NOTE: eRegister's register routes take a mode ("prod" or "test"); the chatbot works on the live registers
export const EREGISTER_REGISTER_MODE = "prod";

// DEV_NOTE: An eRegister record id in a path: a public id, handle or numeric id. Letters, digits, _ and - only, so a
// value can never add a path segment (the renderer URL-encodes it too).
export const EREGISTER_ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

export const eregisterIdProperty = (description: string): Record<string, unknown> => ({
  type: "string",
  description,
  pattern: EREGISTER_ID_PATTERN,
});

// DEV_NOTE: The user's eRegister company: every eRegister path is scoped to one. The model takes it from
// eregister_list_companies (eRegister checks the user belongs to it, from the Firebase token).
export const EREGISTER_COMPANY_ID_PROPERTY = eregisterIdProperty(
  "The eRegister company's id, from eregister_list_companies",
);

type JsonSchema = Record<string, unknown>;

interface BuildEregisterInputSchemaParams {
  // Path args (companyId is always first and required)
  pathArgs?: Record<string, JsonSchema>;
  // A generated request body whose properties become args too
  body?: EregisterInputSchemaName;
  // Only these body properties (an update takes only the fields it can read back and restore)
  pick?: string[];
  // More args, not from the body
  extra?: Record<string, JsonSchema>;
  // Required args beyond the path args (the body's own required list is kept, cut to the picked properties)
  required?: string[];
}

// DEV_NOTE: A tool's input_schema: companyId + path args + a generated eRegister body's properties, with the body's
// $defs at the root (the args validator resolves a $ref from the root only). Typed as input_schema without a parse:
// EregisterTools.test.ts runs every tool through normalizeToolOps and the args validator.
export function buildEregisterInputSchema(
  params: BuildEregisterInputSchemaParams,
): ToolOpsV1Input["inputSchema"] {
  const body = params.body ? EREGISTER_INPUT_SCHEMAS[params.body] : undefined;
  const bodyProperties = (body?.properties ?? {}) as Record<string, JsonSchema>;
  const picked = params.pick
    ? Object.fromEntries(params.pick.map((name) => [name, bodyProperties[name]]))
    : bodyProperties;
  for (const [name, property] of Object.entries(picked)) {
    if (!property) throw new Error(`eRegister body ${params.body} has no ${name}`);
  }
  const pathArgs = { companyId: EREGISTER_COMPANY_ID_PROPERTY, ...params.pathArgs };
  const properties = { ...pathArgs, ...picked, ...params.extra };
  const bodyRequired = ((body?.required ?? []) as string[]).filter((name) => name in picked);
  const required = [
    ...new Set([...Object.keys(pathArgs), ...bodyRequired, ...(params.required ?? [])]),
  ];
  return {
    type: "object",
    properties,
    required,
    ...(body?.$defs ? { $defs: body.$defs } : {}),
  } as ToolOpsV1Input["inputSchema"];
}

// DEV_NOTE: A body map sending each named arg as itself ({args.x} keeps the value's JSON type; an omitted arg's key is
// dropped)
export const argsBodyMap = (names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `{args.${name}}`]));

// DEV_NOTE: A body map restoring each field from the read-before at root.<field> (an inverse op)
export const beforeBodyMap = (root: string, names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `{before.${root}.${name}}`]));

// DEV_NOTE: A readback compare: each arg against root.<arg> (or root.<mapped name> where eRegister names it otherwise)
export const compareAt = (
  root: string,
  names: string[],
  renamed: Record<string, string> = {},
): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `${root}.${renamed[name] ?? name}`]));
