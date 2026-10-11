import { z } from "zod";
import type { ApiResponse } from "../common";
import type { ToolOps } from "./ToolOpsRegistry";

// DEV_NOTE: The model's tool args are checked against the tool's input_schema (JSON Schema) before renderToolOp sees
// them (M3-4): types, enums, formats, bounds and required, which the renderer doesn't check (it drops a missing arg's
// key). The schema is turned into a Zod schema with zod's own fromJSONSchema; a schema it can't convert (if/then/else,
// not, external $ref…), or one using a keyword it would accept but never enforce (uniqueItems, contains,
// min/maxProperties, a format it doesn't know, a pattern that needs the u flag), has no validator, so the tool is
// refused on save and left out of a turn (never run half-checked). Nothing here throws.
//
// Undeclared keys: JSON Schema lets an object hold keys it doesn't declare, and fromJSONSchema passes them through, so
// after validation the args are cut to what the schema declares, at every depth (properties of the object and of
// every allOf / anyOf / oneOf branch and $ref it names). Only an object whose schema explicitly allows more
// (additionalProperties, patternProperties or propertyNames) keeps other keys; the top level never does.

export type ToolInputSchema = ToolOps["inputSchema"];

export interface BuildToolArgsValidatorResponse extends ApiResponse {
  validator?: z.ZodType;
}

export interface ValidateToolArgsResponse extends ApiResponse {
  // Only what the input_schema declares, at every depth: an extra key the model sent is dropped, so nothing undeclared
  // is stored or sent
  args?: Record<string, unknown>;
  // Where the args failed (path and reason, never the value), for the model to fix its call
  issues?: string[];
}

type JsonSchemaNode = Record<string, unknown>;

// DEV_NOTE: Keywords fromJSONSchema recognises but doesn't enforce (zod 4.4)
const UNENFORCED_KEYWORDS = [
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
];
// DEV_NOTE: The formats fromJSONSchema maps to a check; any other is silently a plain string
const ENFORCED_FORMATS = new Set([
  "email",
  "uri",
  "uri-reference",
  "uuid",
  "guid",
  "date-time",
  "date",
  "time",
  "duration",
  "ipv4",
  "ipv6",
  "mac",
  "cidr",
  "cidr-v6",
  "base64",
  "base64url",
  "e164",
  "jwt",
  "emoji",
  "nanoid",
  "cuid",
  "cuid2",
  "ulid",
  "xid",
  "ksuid",
]);
// DEV_NOTE: fromJSONSchema compiles a pattern without the u flag, so \p{…} and \u{…} would mean something else
const UNICODE_ONLY_ESCAPE = /\\[pP]\{|\\u\{/;
const SUBSCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SUBSCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"];
const SUBSCHEMA_KEYWORDS = ["items", "additionalProperties", "additionalItems", "propertyNames"];

const isNode = (value: unknown): value is JsonSchemaNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// DEV_NOTE: Every subschema of a node (one level down), for the walk below
function childSchemas(node: JsonSchemaNode): unknown[] {
  const children: unknown[] = [];
  for (const key of SUBSCHEMA_LIST_KEYWORDS) {
    const list = node[key];
    if (Array.isArray(list)) children.push(...list);
  }
  for (const key of SUBSCHEMA_MAP_KEYWORDS) {
    const map = node[key];
    if (isNode(map)) children.push(...Object.values(map));
  }
  for (const key of SUBSCHEMA_KEYWORDS) {
    const child = node[key];
    if (Array.isArray(child)) children.push(...child);
    else children.push(child);
  }
  return children.filter(isNode);
}

// DEV_NOTE: The first keyword in the schema that would be accepted but not enforced; null when there is none
function findUnenforcedKeyword(schema: unknown): string | null {
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isNode(node)) continue;
    const keyword = UNENFORCED_KEYWORDS.find((name) => node[name] !== undefined);
    if (keyword) return keyword;
    if (typeof node.format === "string" && !ENFORCED_FORMATS.has(node.format)) {
      return `format "${node.format}"`;
    }
    if (typeof node.pattern === "string") {
      if (UNICODE_ONLY_ESCAPE.test(node.pattern)) return "a pattern that needs the u flag";
      try {
        new RegExp(node.pattern);
      } catch {
        return "a pattern that doesn't compile";
      }
    }
    pending.push(...childSchemas(node));
  }
  return null;
}

export function buildToolArgsValidator(
  inputSchema: ToolInputSchema,
): BuildToolArgsValidatorResponse {
  const unenforced = findUnenforcedKeyword(inputSchema);
  if (unenforced) {
    return { isSuccess: false, message: `input_schema can't be checked: ${unenforced}` };
  }
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

// DEV_NOTE: A local $ref (#/$defs/x or #/definitions/x) from the root; anything else resolves to nothing (fromJSONSchema
// already refused an external one)
function resolveRef(root: JsonSchemaNode, node: JsonSchemaNode): JsonSchemaNode {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let target: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    target = isNode(target) ? target[segment] : undefined;
  }
  return isNode(target) ? target : node;
}

// DEV_NOTE: A node and every allOf / anyOf / oneOf branch and $ref under it: the schemas a value at this spot may be
// checked against. Bounded by the schema's own size (a $ref seen once isn't followed again).
function alternatives(root: JsonSchemaNode, node: JsonSchemaNode): JsonSchemaNode[] {
  const found: JsonSchemaNode[] = [];
  const seen = new Set<JsonSchemaNode>();
  const pending: JsonSchemaNode[] = [node];
  while (pending.length > 0) {
    const current = resolveRef(root, pending.pop()!);
    if (seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const list = current[key];
      if (Array.isArray(list)) pending.push(...list.filter(isNode));
    }
  }
  return found;
}

// DEV_NOTE: value cut to what the schemas at its spot declare, recursively. Follows the value, so it ends with it.
function stripUndeclared(root: JsonSchemaNode, schemas: JsonSchemaNode[], value: unknown): unknown {
  const nodes = schemas.flatMap((schema) => alternatives(root, schema));
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const itemSchemas = nodes.flatMap((node) => {
        const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : null;
        const positional = prefix && index < prefix.length ? prefix[index] : undefined;
        const items = positional ?? (Array.isArray(node.items) ? node.items[index] : node.items);
        return isNode(items) ? [items] : [];
      });
      return stripUndeclared(root, itemSchemas, item);
    });
  }
  if (!isNode(value)) return value;

  const keepsOthers = nodes.some(
    (node) =>
      (node.additionalProperties !== undefined && node.additionalProperties !== false) ||
      node.patternProperties !== undefined ||
      node.propertyNames !== undefined,
  );
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childSchemas = nodes.flatMap((node) => {
      const properties = node.properties;
      const declared =
        isNode(properties) && Object.hasOwn(properties, key) ? properties[key] : null;
      return isNode(declared) ? [declared] : [];
    });
    if (childSchemas.length === 0 && !keepsOthers) continue;
    result[key] = stripUndeclared(root, childSchemas, child);
  }
  return result;
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
  const root: JsonSchemaNode = inputSchema;
  const declared = Object.entries(inputSchema.properties).filter(
    ([name]) => Object.hasOwn(data, name) && data[name] !== undefined,
  );
  return {
    isSuccess: true,
    message: "Tool args valid",
    args: Object.fromEntries(
      declared.map(([name, schema]) => [name, stripUndeclared(root, [schema], data[name])]),
    ),
  };
}
