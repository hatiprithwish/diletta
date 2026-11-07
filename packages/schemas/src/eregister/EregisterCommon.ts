import type { ToolDefinitionSeed } from "../toolDefinitions/ToolDefinitionsCommon";
import type { ToolOpsV1Input } from "../toolDefinitions/ToolOpsV1";
import type { OpenApiShaping } from "../toolContracts/ToolContractsCommon";

// DEV_NOTE: eRegister, the first customer host (M7, docs/runbooks/eregister.md). Its connection's base_url is
// {eRegister API}/api/p/, so every tool path below starts at /companies/{companyId}/…. The tools are bindings written
// here (M7-2): which fields a tool sends, how it is read back and undone. The schema of each field comes from
// eRegister's OpenAPI spec (/api/openapi.json) when the tools are loaded and on every sync (ADR 0009), never from
// this code: a body field's definition here is an empty placeholder.
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

// DEV_NOTE: The request body fields a tool sends, by body (the binding: a field a tool doesn't list is never sent).
// companyId is a path arg, not a body field.
export const EREGISTER_BODY_FIELDS = {
  registerBody: [
    "name",
    "schema",
    "flowSchema",
    "oldCategoryId",
    "newCategoryName",
    "defaultView",
    "type",
  ],
  createCodeblockBody: [
    "name",
    "description",
    "type",
    "inputSchema",
    "outputSchema",
    "packages",
    "variables",
    "sourceFiles",
    "source",
  ],
  updateCodeblockBody: [
    "name",
    "description",
    "inputSchema",
    "outputSchema",
    "packages",
    "variables",
    "sourceFiles",
    "source",
  ],
  createLayoutBody: [
    "name",
    "category",
    "layoutType",
    "content",
    "defaultPrintFormat",
    "inputSchema",
  ],
  updateLayoutBody: ["name", "content", "defaultPrintFormat", "inputSchema"],
  actionBody: ["name", "description", "flowSchema", "isEnabled", "triggers", "steps"],
  createReportBody: [
    "name",
    "description",
    "sqlQuery",
    "inputSchema",
    "outputSchema",
    "rolesAccess",
    "transformCodeblockPid",
  ],
  updateReportBody: [
    "name",
    "description",
    "sqlQuery",
    "inputSchema",
    "outputSchema",
    "columnSizes",
    "rolesAccess",
    "transformCodeblockPid",
  ],
  createChartBody: ["name", "config"],
  updateChartBody: ["name", "config"],
  createDashboardBody: ["name", "description", "inputSchema", "rolesAccess"],
  updateDashboardBody: ["name", "description", "inputSchema", "rolesAccess"],
  createWidgetBody: ["reportChartId", "layout", "mapping", "config", "codeblockPid", "type"],
  updateWidgetBody: ["layout", "mapping", "config", "type"],
  // A register entry: data holds the first step's fields (keyed by field id); insertId is the entry's External ID
  createEntryBody: ["data", "notes", "insertId"],
  createButtonBody: [
    "name",
    "description",
    "status",
    "priority",
    "executionConfig",
    "confirmationConfig",
    "displayLogicFn",
    "registerPid",
    "scopeConfig",
  ],
  updateButtonBody: [
    "name",
    "description",
    "status",
    "priority",
    "executionConfig",
    "confirmationConfig",
    "displayLogicFn",
  ],
} as const;
export type EregisterBodyName = keyof typeof EREGISTER_BODY_FIELDS;

// DEV_NOTE: How eRegister's contract is shaped for the model (ADR 0009), set on its connection (openapi_shaping): a
// field with a default is required, so a read-back compares equal to what eRegister stored; the form field unions
// (~60K chars of JSON Schema in most bodies) are a loose object, and the model reads one field type's exact shape with
// eregister_get_field_types.
const EREGISTER_FORM_FIELD_SCHEMA = {
  type: "object",
  description:
    "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.",
  properties: { id: { type: "string" }, label: { type: "string" }, type: { type: "string" } },
  required: ["id", "label", "type"],
  additionalProperties: true,
};
export const EREGISTER_OPENAPI_SHAPING: OpenApiShaping = {
  isDefaultRequired: true,
  replaceComponents: Object.fromEntries(
    ["FormField", "TableFormField", "ExtendedFormField", "ReviewFormField", "LayoutFormField"].map(
      (name) => [name, EREGISTER_FORM_FIELD_SCHEMA],
    ),
  ),
};

type JsonSchema = Record<string, unknown>;

interface BuildEregisterInputSchemaParams {
  // Path args (companyId is always first and required)
  pathArgs?: Record<string, JsonSchema>;
  // A generated request body whose properties become args too
  body?: EregisterBodyName;
  // Only these body properties (an update takes only the fields it can read back and restore)
  pick?: string[];
  // More args, not from the body
  extra?: Record<string, JsonSchema>;
  // Required args beyond the path args (a body field's required-ness comes from the spec)
  required?: string[];
}

// DEV_NOTE: A tool's input_schema as the binding declares it: companyId + path args + the body fields it sends (each an
// empty schema) + extra args. A body field's real schema is derived from the spec when the tool is stored
// (deriveToolInputSchema), so this is never stored for a body field as it is.
export function buildEregisterInputSchema(
  params: BuildEregisterInputSchemaParams,
): ToolOpsV1Input["inputSchema"] {
  const bodyFields: string[] = params.body ? [...EREGISTER_BODY_FIELDS[params.body]] : [];
  const picked = params.pick ?? bodyFields;
  for (const name of picked) {
    if (!bodyFields.includes(name)) throw new Error(`eRegister body ${params.body} has no ${name}`);
  }
  const body: Record<string, JsonSchema> = Object.fromEntries(picked.map((name) => [name, {}]));
  const pathArgs = { companyId: EREGISTER_COMPANY_ID_PROPERTY, ...params.pathArgs };
  const properties = { ...pathArgs, ...body, ...params.extra };
  const required = [...new Set([...Object.keys(pathArgs), ...(params.required ?? [])])];
  return { type: "object", properties, required } as ToolOpsV1Input["inputSchema"];
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
