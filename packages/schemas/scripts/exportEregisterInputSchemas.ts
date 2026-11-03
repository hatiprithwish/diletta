import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// DEV_NOTE: Writes src/eregister/EregisterInputSchemas.ts: the JSON Schema of each eRegister request body an eRegister
// tool sends (M7-2), generated from eregister-types' own Zod schemas so the tools name eRegister's real fields.
//   pnpm --filter @app/schemas eregister:schemas --eregister <path to an eregister-backend checkout>
// Rerun when eRegister changes one of these bodies, and commit the output (its header names the eRegister commit).
// eRegister's own zod converts them (createRequire from eregister-types), never ours. io "output": a field with a
// default is required, so the model sends it and the read-back compares equal to what eRegister stored. Refinements
// aren't representable and are left out: eRegister still enforces them.

const { values } = parseArgs({ options: { eregister: { type: "string" } } });
if (!values.eregister) {
  throw new Error("Usage: eregister:schemas --eregister <path to eregister-backend>");
}
const root = path.resolve(values.eregister);
const typesIndex = path.join(root, "packages/eregister-types/src/index.ts");

interface ZodSchemaLike {
  shape?: Record<string, ZodSchemaLike>;
}
type JsonSchema = Record<string, unknown>;
interface OverrideContext {
  zodSchema: unknown;
  jsonSchema: JsonSchema;
}
interface EregisterZod {
  object: (shape: Record<string, ZodSchemaLike>) => ZodSchemaLike;
  toJSONSchema: (schema: ZodSchemaLike, params: Record<string, unknown>) => JsonSchema;
}

const zodEntry = createRequire(typesIndex).resolve("zod");
const z = (await import(pathToFileURL(zodEntry).href)) as unknown as EregisterZod;
const types = (await import(pathToFileURL(typesIndex).href)) as Record<string, ZodSchemaLike>;
const formTypes = (await import(
  pathToFileURL(path.join(root, "packages/form-types/src/index.ts")).href
)) as Record<string, unknown>;

// DEV_NOTE: The register field union is ~60K chars of JSON Schema, and most bodies hold it (register steps, code
// block IO, layout, report and dashboard sections): every one of those nodes becomes a loose object, and the model
// reads one field type's shape on demand with the eregister_get_field_types tool (EregisterTools.ts).
const FIELD_SCHEMAS = new Set(
  ["FieldSchemaObj", "TableFieldSchemaObj", "ExtendedFieldSchemaObj", "ReviewFieldSchemaObj"]
    .map((name) => formTypes[name])
    .concat(types.ZLayoutFieldSchema),
);
if (FIELD_SCHEMAS.has(undefined)) throw new Error("A field schema export is missing");
const FIELD_DESCRIPTION =
  "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.";

function looseField(ctx: OverrideContext): void {
  if (!FIELD_SCHEMAS.has(ctx.zodSchema)) return;
  for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
  Object.assign(ctx.jsonSchema, {
    type: "object",
    description: FIELD_DESCRIPTION,
    properties: { id: { type: "string" }, label: { type: "string" }, type: { type: "string" } },
    required: ["id", "label", "type"],
    additionalProperties: true,
  });
}

const CONVERT = { io: "output", unrepresentable: "any", reused: "ref", override: looseField };

function schemaOf(name: string): ZodSchemaLike {
  const schema = types[name];
  if (!schema) throw new Error(`eregister-types has no ${name}`);
  return schema;
}

// DEV_NOTE: An object body, optionally without some keys (the presigned-upload ones the chatbot can't use)
function objectBody(name: string, omit: string[] = []): ZodSchemaLike {
  const shape = schemaOf(name).shape;
  if (!shape) throw new Error(`${name} is not an object schema`);
  return z.object(Object.fromEntries(Object.entries(shape).filter(([key]) => !omit.includes(key))));
}

function deref(node: unknown, defs: Record<string, JsonSchema>): JsonSchema {
  const json = node as JsonSchema;
  if (typeof json.$ref !== "string") return json;
  return deref(defs[json.$ref.replace("#/$defs/", "")], defs);
}

// DEV_NOTE: A discriminated union of objects flattened into one object (the tool's args are one flat object): every
// member's properties, the discriminator an enum of the members' values. eRegister checks the member on its side.
function unionBody(name: string, discriminator: string): JsonSchema {
  const { $schema: _schema, oneOf, anyOf, ...rest } = z.toJSONSchema(schemaOf(name), CONVERT);
  const defs = (rest.$defs ?? {}) as Record<string, JsonSchema>;
  const members = (oneOf ?? anyOf) as unknown[] | undefined;
  if (!members) throw new Error(`${name} is not a union`);
  const properties: JsonSchema = {};
  const tags: unknown[] = [];
  for (const member of members) {
    const memberProperties = deref(member, defs).properties as JsonSchema;
    for (const [key, value] of Object.entries(memberProperties)) {
      if (key === discriminator) tags.push(deref(value, defs).const);
      else properties[key] ??= value;
    }
  }
  properties[discriminator] = { enum: tags };
  return pruneDefs({ ...rest, type: "object", properties, required: [discriminator] });
}

// DEV_NOTE: Only the $defs the schema still reaches: the field schemas looseField replaced leave theirs behind
function pruneDefs(json: JsonSchema): JsonSchema {
  const { $defs, ...rest } = json;
  const defs = ($defs ?? {}) as Record<string, JsonSchema>;
  const kept = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const name = value.replace("#/$defs/", "");
        if (!kept.has(name)) {
          kept.add(name);
          visit(defs[name]);
        }
      } else visit(value);
    }
  };
  visit(rest);
  if (kept.size === 0) return rest;
  return { ...rest, $defs: Object.fromEntries([...kept].sort().map((name) => [name, defs[name]])) };
}

function toJson(schema: ZodSchemaLike): JsonSchema {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, CONVERT);
  return pruneDefs(json);
}

const SCHEMAS: Record<string, JsonSchema> = {
  registerBody: toJson(objectBody("ZCreateRegisterReq")),
  createCodeblockBody: toJson(objectBody("ZCreateCodeblockReq", ["fileInfo"])),
  updateCodeblockBody: toJson(objectBody("ZUpdateCodeblockReq", ["fileInfo"])),
  createLayoutBody: toJson(objectBody("ZCreateLayoutReq", ["fileId", "fileName"])),
  updateLayoutBody: toJson(objectBody("ZUpdateLayoutReq", ["fileId", "fileName"])),
  actionBody: toJson(objectBody("ZCreateActionRequest")),
  createReportBody: toJson(objectBody("ZCreateAdvancedReportReq", ["type"])),
  updateReportBody: toJson(objectBody("ZUpdateAdvancedReportReq")),
  createChartBody: toJson(objectBody("ZCreateReportChartReq")),
  updateChartBody: toJson(objectBody("ZUpdateReportChartReq")),
  createDashboardBody: toJson(objectBody("ZCreateDashboardReq")),
  updateDashboardBody: toJson(objectBody("ZUpdateDashboardReq")),
  createWidgetBody: unionBody("ZCreateWidgetBody", "type"),
  updateWidgetBody: unionBody("ZUpdateWidgetReq", "type"),
  createButtonBody: toJson(objectBody("ZCreateButtonReq")),
  updateButtonBody: toJson(objectBody("ZUpdateButtonReq")),
};

const commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"]).toString().trim();
const out = new URL("../src/eregister/EregisterInputSchemas.ts", import.meta.url);
await writeFile(
  out,
  [
    "// Generated by scripts/exportEregisterInputSchemas.ts from eregister-backend " +
      commit +
      ". Never edit by hand:",
    "// rerun `pnpm --filter @app/schemas eregister:schemas --eregister <path>` instead.",
    "",
    "export type EregisterInputSchemaName =",
    ...Object.keys(SCHEMAS).map(
      (name, index, all) => `  | "${name}"${index === all.length - 1 ? ";" : ""}`,
    ),
    "",
    "export const EREGISTER_INPUT_SCHEMAS: Record<EregisterInputSchemaName, Record<string, unknown>> = " +
      JSON.stringify(SCHEMAS, null, 2) +
      ";",
    "",
  ].join("\n"),
);
execFileSync("pnpm", ["exec", "prettier", "--write", out.pathname], { stdio: "ignore" });
for (const [name, schema] of Object.entries(SCHEMAS)) {
  process.stdout.write(`${name}: ${JSON.stringify(schema).length} chars\n`);
}
