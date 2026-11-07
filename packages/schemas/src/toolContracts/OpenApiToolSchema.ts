import { detectPromptInjection } from "../promptInjection/PromptInjectionCommon";
import { getToolInputSchemaIssue } from "../toolDefinitions/ToolArgsValidator";
import type { ToolCallOp, ToolOps } from "../toolDefinitions/ToolOpsRegistry";
import {
  TOOL_CONTRACT_MAX_DEFS,
  ToolContractSyncFailureIntEnum,
  type OpenApiShaping,
} from "./ToolContractsCommon";

// DEV_NOTE: An OpenAPI 3.0 / 3.1 operation turned into a tool's input_schema (ADR 0009). Pure; never throws.
//   The binding decides which args reach the host: each query value and body-map entry that is exactly {args.X}.
//   Only those args take their schema from the spec; every other arg (path ids, a list tool's own args, a body field
//   the spec doesn't name) keeps its current definition. Path params are never re-typed (the binding owns ids).
//   Components a synced arg reaches are copied into $defs (refs rewritten), so the schema stands alone.
//   OpenAPI-only keywords are dropped, 3.0's nullable becomes a type array, readOnly properties are dropped, and a
//   description breaking a detectPromptInjection rule is dropped (spec text is host text).
//   Shaping (per connection) then applies, and the result must pass getToolInputSchemaIssue.

type Json = Record<string, unknown>;
type ToolInputSchema = ToolOps["inputSchema"];

export type OpenApiSpec = {
  openapi: string;
  paths: Record<string, Json>;
  components?: Json;
};

export type OpenApiOperationSummary = { operationId: string; method: string; path: string };

export type ToolContractResult<T> =
  | ({ isSuccess: true; message: string } & T)
  | { isSuccess: false; failure: ToolContractSyncFailureIntEnum; message: string };

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];
const ARG_PLACEHOLDER = /^\{args\.([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;
const COMPONENT_SCHEMA_REF = "#/components/schemas/";
const DEF_REF = "#/$defs/";
const DEF_NAME = /^[A-Za-z0-9_.-]{1,200}$/;
// Keywords that mean nothing to the args validator or the model, and only cost context
const DROPPED_KEYWORDS = new Set([
  "discriminator",
  "xml",
  "externalDocs",
  "example",
  "examples",
  "deprecated",
  "nullable",
  "$schema",
  "$id",
]);

const isNode = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (
  failure: ToolContractSyncFailureIntEnum,
  message: string,
): { isSuccess: false; failure: ToolContractSyncFailureIntEnum; message: string } => ({
  isSuccess: false,
  failure,
  message,
});

export function parseOpenApiSpec(body: unknown): ToolContractResult<{ spec: OpenApiSpec }> {
  if (!isNode(body))
    return fail(ToolContractSyncFailureIntEnum.NotOpenApi, "Spec isn't a JSON object");
  if (typeof body.swagger === "string") {
    return fail(
      ToolContractSyncFailureIntEnum.NotOpenApi,
      "Swagger 2.0 isn't supported: use OpenAPI 3",
    );
  }
  if (typeof body.openapi !== "string" || !/^3\.[01]\./.test(body.openapi)) {
    return fail(ToolContractSyncFailureIntEnum.NotOpenApi, "Spec isn't OpenAPI 3.0 or 3.1");
  }
  if (!isNode(body.paths))
    return fail(ToolContractSyncFailureIntEnum.NotOpenApi, "Spec has no paths");
  if (body.components !== undefined && !isNode(body.components)) {
    return fail(ToolContractSyncFailureIntEnum.NotOpenApi, "Spec components isn't an object");
  }
  return {
    isSuccess: true,
    message: "Spec read",
    spec: {
      openapi: body.openapi,
      paths: body.paths as Record<string, Json>,
      components: body.components as Json,
    },
  };
}

// DEV_NOTE: A local JSON pointer into the spec (#/components/…); anything else (another file, a URL) is null
function resolvePointer(spec: OpenApiSpec, ref: string): unknown {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = spec;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isNode(node) || !Object.hasOwn(node, key)) return null;
    node = node[key];
  }
  return node;
}

// DEV_NOTE: Follows a chain of $refs to the node they name (at most 16, so a loop can't hang)
function deref(spec: OpenApiSpec, node: unknown): Json | null {
  let current = node;
  for (let hop = 0; hop < 16; hop++) {
    if (!isNode(current)) return null;
    if (typeof current.$ref !== "string") return current;
    current = resolvePointer(spec, current.$ref);
  }
  return null;
}

export function listOpenApiOperations(spec: OpenApiSpec): OpenApiOperationSummary[] {
  const operations: OpenApiOperationSummary[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!isNode(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (isNode(operation) && typeof operation.operationId === "string") {
        operations.push({ operationId: operation.operationId, method: method.toUpperCase(), path });
      }
    }
  }
  return operations;
}

// DEV_NOTE: The spec operation a call_op sends: same method, and each path segment the same (a placeholder matches a
// placeholder whatever its name: {args.actionId} ↔ {actionPublicId}). A literal the tool fixes may fill a spec
// placeholder ("prod" ↔ {mode}); an exact match wins over one that needs that. Both paths are relative to the API root
// (the connection's base_url and the spec's server).
export function matchOpenApiOperation(
  spec: OpenApiSpec,
  callOp: Pick<ToolCallOp, "method" | "path">,
): string | null {
  const segments = (path: string) => path.split("/").filter(Boolean);
  const target = segments(callOp.path);
  let best: { operationId: string; filled: number } | null = null;
  for (const operation of listOpenApiOperations(spec)) {
    if (operation.method !== callOp.method) continue;
    const candidate = segments(operation.path);
    if (candidate.length !== target.length) continue;
    let filled = 0;
    const isMatch = candidate.every((segment, index) => {
      const own = target[index] as string;
      const isSpecParam = /^\{[^}]+\}$/.test(segment);
      const isToolParam = /^\{args\.[^}]+\}$/.test(own);
      if (isSpecParam && isToolParam) return true;
      if (isSpecParam && !own.includes("{")) {
        filled += 1;
        return true;
      }
      return segment === own;
    });
    if (isMatch && (!best || filled < best.filled))
      best = { operationId: operation.operationId, filled };
  }
  return best?.operationId ?? null;
}

function findOperation(
  spec: OpenApiSpec,
  operationId: string,
): { operation: Json; pathItem: Json } | null {
  for (const pathItem of Object.values(spec.paths)) {
    if (!isNode(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (isNode(operation) && operation.operationId === operationId)
        return { operation, pathItem };
    }
  }
  return null;
}

const argOf = (value: unknown): string | null =>
  typeof value === "string" ? (ARG_PLACEHOLDER.exec(value)?.[1] ?? null) : null;

// DEV_NOTE: A union of objects at a body's top flattened into one object: every member's properties (the first wins),
// a property every member fixes with const becomes an enum of those values; required = what every member requires.
// The host still checks the member.
function flattenUnion(spec: OpenApiSpec, body: Json): Json {
  const members = (body.oneOf ?? body.anyOf) as unknown[] | undefined;
  if (!Array.isArray(members) || members.length === 0) return body;
  const resolved = members.map((member) => deref(spec, member));
  if (resolved.some((member) => !member || !isNode(member.properties))) return body;
  const objects = resolved as Json[];
  const properties: Json = {};
  const consts = new Map<string, unknown[]>();
  for (const member of objects) {
    for (const [name, property] of Object.entries(member.properties as Json)) {
      const field = deref(spec, property);
      if (field && Object.hasOwn(field, "const"))
        consts.set(name, [...(consts.get(name) ?? []), field.const]);
      else properties[name] ??= property;
    }
  }
  const required = objects
    .map((member) => new Set((member.required as string[] | undefined) ?? []))
    .reduce((all, next) => new Set([...all].filter((name) => next.has(name))));
  for (const [name, values] of consts) {
    if (values.length === objects.length) {
      properties[name] = { enum: values };
      required.add(name);
    } else properties[name] ??= { enum: values };
  }
  return { type: "object", properties, required: [...required] };
}

type SyncedArg = { schema: unknown; isRequired: boolean };

function queryArgs(
  spec: OpenApiSpec,
  callOp: ToolCallOp,
  found: { operation: Json; pathItem: Json },
) {
  const synced = new Map<string, SyncedArg>();
  const parameters = [
    ...((found.pathItem.parameters as unknown[] | undefined) ?? []),
    ...((found.operation.parameters as unknown[] | undefined) ?? []),
  ]
    .map((parameter) => deref(spec, parameter))
    .filter((parameter): parameter is Json => parameter !== null && parameter.in === "query");
  for (const [name, value] of Object.entries(callOp.query ?? {})) {
    const arg = argOf(value);
    const parameter = parameters.find((candidate) => candidate.name === name);
    if (!arg || !parameter || !isNode(parameter.schema)) continue;
    const schema =
      typeof parameter.description === "string" && parameter.schema.description === undefined
        ? { ...parameter.schema, description: parameter.description }
        : parameter.schema;
    synced.set(arg, { schema, isRequired: parameter.required === true });
  }
  return synced;
}

// DEV_NOTE: The body schema at each {args.X} the body map places, following the map into nested objects and arrays
// (widgets: [{ type: "{args.type}" }] reads widgets.items.type). An arg is required when its field and every field
// above it are. A field the map sends that the spec doesn't name is listed as missing (its arg keeps its definition).
function bodyArgs(spec: OpenApiSpec, callOp: ToolCallOp, operation: Json, shaping: OpenApiShaping) {
  const synced = new Map<string, SyncedArg>();
  const missing: string[] = [];
  const requestBody = deref(spec, operation.requestBody);
  const content = requestBody && isNode(requestBody.content) ? requestBody.content : null;
  const json = content && isNode(content["application/json"]) ? content["application/json"] : null;

  const visit = (template: unknown, schema: unknown, path: string, isRequired: boolean): void => {
    const resolved = schema === undefined ? null : deref(spec, schema);
    if (Array.isArray(template)) {
      const items = resolved && resolved.items !== undefined ? resolved.items : undefined;
      template.forEach((item) => visit(item, items, `${path}[]`, isRequired));
      return;
    }
    if (!isNode(template)) return;
    const body = resolved ? flattenUnion(spec, resolved) : null;
    const properties = body && isNode(body.properties) ? body.properties : null;
    const required = new Set((body?.required as string[] | undefined) ?? []);
    for (const [key, value] of Object.entries(template)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const property = properties?.[key];
      if (property === undefined) {
        if (argOf(value) || isNode(value) || Array.isArray(value)) missing.push(fieldPath);
        continue;
      }
      const arg = argOf(value);
      if (!arg) {
        visit(value, property, fieldPath, isRequired && required.has(key));
        continue;
      }
      const field = deref(spec, property);
      const hasDefault = field !== null && Object.hasOwn(field, "default");
      synced.set(arg, {
        schema: property,
        isRequired: isRequired && (required.has(key) || (shaping.isDefaultRequired && hasDefault)),
      });
    }
  };

  if (callOp.bodyMap) visit(callOp.bodyMap, json ? json.schema : undefined, "", true);
  return { synced, missing };
}

// DEV_NOTE: OpenAPI-only keywords dropped, 3.0 nullable folded into the type, readOnly properties dropped, flagged
// descriptions dropped, component refs pointed at $defs; with isDefaultRequired, a property with a default required
function cleanSchema(node: unknown, shaping: OpenApiShaping, depth = 0): unknown {
  if (depth > 64) return {};
  if (Array.isArray(node)) return node.map((item) => cleanSchema(item, shaping, depth + 1));
  if (!isNode(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "$ref" && typeof value === "string") {
      out.$ref = value.startsWith(COMPONENT_SCHEMA_REF)
        ? `${DEF_REF}${value.slice(COMPONENT_SCHEMA_REF.length)}`
        : value;
      continue;
    }
    if (key === "description" && typeof value === "string") {
      if (!detectPromptInjection(value).isDetected) out.description = value;
      continue;
    }
    if (key === "properties" && isNode(value)) {
      const properties: Json = {};
      for (const [name, property] of Object.entries(value)) {
        if (isNode(property) && property.readOnly === true) continue;
        properties[name] = cleanSchema(property, shaping, depth + 1);
      }
      out.properties = properties;
      continue;
    }
    out[key] = cleanSchema(value, shaping, depth + 1);
  }
  if (node.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  if (isNode(out.properties)) {
    const names = Object.keys(out.properties);
    const required = ((out.required as string[] | undefined) ?? []).filter((name) =>
      names.includes(name),
    );
    if (shaping.isDefaultRequired) {
      for (const [name, property] of Object.entries(out.properties)) {
        if (isNode(property) && Object.hasOwn(property, "default") && !required.includes(name))
          required.push(name);
      }
    }
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

function collectRefs(node: unknown, prefix: string, into: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((item) => collectRefs(item, prefix, into));
  if (!isNode(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith(prefix))
      into.add(value.slice(prefix.length));
    else collectRefs(value, prefix, into);
  }
}

// DEV_NOTE: Every spec component the synced args reach, transitively
function reachableComponents(
  spec: OpenApiSpec,
  roots: unknown[],
  replaced: ReadonlySet<string>,
): Map<string, unknown> | string {
  const schemas = isNode(spec.components?.schemas) ? (spec.components.schemas as Json) : {};
  const found = new Map<string, unknown>();
  const queue: string[] = [];
  const enqueue = (node: unknown) => {
    const refs = new Set<string>();
    collectRefs(node, COMPONENT_SCHEMA_REF, refs);
    for (const name of refs) if (!found.has(name)) queue.push(name);
  };
  roots.forEach(enqueue);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (found.has(name)) continue;
    if (!DEF_NAME.test(name)) return `Component name ${name.slice(0, 80)} can't be used`;
    if (!Object.hasOwn(schemas, name)) return `Component ${name} isn't in the spec`;
    if (found.size >= TOOL_CONTRACT_MAX_DEFS)
      return `More than ${TOOL_CONTRACT_MAX_DEFS} components`;
    found.set(name, schemas[name]);
    // A replaced component's own parts never reach the tool
    if (!replaced.has(name)) enqueue(schemas[name]);
  }
  return found;
}

// DEV_NOTE: The current $defs the kept (binding-owned) args still reach
function keptDefs(current: ToolInputSchema, kept: Json): Json {
  const defs = isNode((current as Json).$defs) ? ((current as Json).$defs as Json) : {};
  const found: Json = {};
  const pending = new Set<string>();
  collectRefs(kept, DEF_REF, pending);
  const queue = [...pending];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (Object.hasOwn(found, name) || !Object.hasOwn(defs, name)) continue;
    found[name] = defs[name];
    const refs = new Set<string>();
    collectRefs(defs[name], DEF_REF, refs);
    queue.push(...refs);
  }
  return found;
}

export function deriveToolInputSchema(params: {
  spec: OpenApiSpec;
  operationId: string;
  callOp: ToolCallOp;
  current: ToolInputSchema;
  shaping: OpenApiShaping;
}): ToolContractResult<{ inputSchema: ToolInputSchema; missingFields: string[] }> {
  const { spec, operationId, callOp, current, shaping } = params;
  const found = findOperation(spec, operationId);
  if (!found) {
    return fail(
      ToolContractSyncFailureIntEnum.OperationMissing,
      `Operation ${operationId} isn't in the spec`,
    );
  }
  const query = queryArgs(spec, callOp, found);
  const body = bodyArgs(spec, callOp, found.operation, shaping);
  const synced = new Map([...query, ...body.synced]);

  const currentProperties = current.properties as Json;
  const kept: Json = {};
  for (const [name, property] of Object.entries(currentProperties)) {
    if (!synced.has(name)) kept[name] = property;
  }
  const components = reachableComponents(
    spec,
    [...synced.values()].map((arg) => arg.schema),
    new Set(Object.keys(shaping.replaceComponents)),
  );
  if (typeof components === "string") {
    return fail(ToolContractSyncFailureIntEnum.SchemaUnenforceable, components);
  }

  const properties: Json = {};
  for (const name of [...Object.keys(currentProperties), ...synced.keys()]) {
    if (Object.hasOwn(properties, name)) continue;
    const arg = synced.get(name);
    properties[name] = arg ? cleanSchema(arg.schema, shaping) : kept[name];
  }
  const currentRequired = ((current.required as string[] | undefined) ?? []).filter(
    (name) => !synced.has(name),
  );
  const required = [
    ...new Set([
      ...currentRequired,
      ...[...synced].filter(([, arg]) => arg.isRequired).map(([name]) => name),
    ]),
  ];

  const defs: Json = keptDefs(current, kept);
  for (const [name, schema] of components) {
    defs[name] = Object.hasOwn(shaping.replaceComponents, name)
      ? shaping.replaceComponents[name]
      : cleanSchema(schema, shaping);
  }

  const inputSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(Object.keys(defs).length > 0
      ? { $defs: Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
  } as ToolInputSchema;
  const issue = getToolInputSchemaIssue(inputSchema);
  if (issue) return fail(ToolContractSyncFailureIntEnum.SchemaUnenforceable, issue);
  return { isSuccess: true, message: "Schema derived", inputSchema, missingFields: body.missing };
}
