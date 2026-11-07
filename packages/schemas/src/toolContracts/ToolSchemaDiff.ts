import type { ToolOps } from "../toolDefinitions/ToolOpsRegistry";
import { TOOL_CONTRACT_MAX_CHANGE_NOTES, ToolSchemaChangeEnum } from "./ToolContractsCommon";

// DEV_NOTE: How a tool's new input_schema differs from its current one (ADR 0009), $defs resolved. Breaking = a call
// valid before may now be refused or mean something else: a removed or newly required field, a type, enum, pattern or
// format the old one allowed and the new one doesn't, a tighter bound, a changed union. Additive = only more is
// accepted, or text changed. Notes name the field paths, never a value. Pure.

type Json = Record<string, unknown>;
type ToolInputSchema = ToolOps["inputSchema"];

const isNode = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems"];
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems"];
const STRICT_KEYWORDS = ["pattern", "format", "const", "multipleOf"];
const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"];
const MAX_DEPTH = 24;

export type ToolSchemaChange = { change: ToolSchemaChangeEnum; notes: string[] };

const asSet = (value: unknown): Set<string> =>
  new Set(
    (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((item) =>
      JSON.stringify(item),
    ),
  );

export function classifyToolSchemaChange(
  before: ToolInputSchema,
  after: ToolInputSchema,
): ToolSchemaChange {
  const notes: string[] = [];
  let change = ToolSchemaChangeEnum.None;
  const note = (severity: ToolSchemaChangeEnum, path: string, what: string) => {
    if (severity === ToolSchemaChangeEnum.Breaking) change = ToolSchemaChangeEnum.Breaking;
    else if (change === ToolSchemaChangeEnum.None) change = ToolSchemaChangeEnum.Additive;
    if (notes.length < TOOL_CONTRACT_MAX_CHANGE_NOTES) notes.push(`${path || "(args)"}: ${what}`);
  };
  const defsOf = (schema: ToolInputSchema): Json =>
    isNode((schema as Json).$defs) ? ((schema as Json).$defs as Json) : {};
  const beforeDefs = defsOf(before);
  const afterDefs = defsOf(after);

  // A $ref resolved within its own schema's $defs; seen stops a recursive shape from looping
  const resolve = (
    node: unknown,
    defs: Json,
    seen: Set<string>,
  ): { node: Json; seen: Set<string> } | null => {
    if (!isNode(node)) return null;
    if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/$defs/")) return { node, seen };
    const name = node.$ref.slice("#/$defs/".length);
    if (seen.has(name)) return null;
    return resolve(defs[name], defs, new Set([...seen, name]));
  };

  const compare = (
    left: unknown,
    right: unknown,
    path: string,
    depth: number,
    seen: { before: Set<string>; after: Set<string> },
  ): void => {
    if (depth > MAX_DEPTH) return;
    const a = resolve(left, beforeDefs, seen.before);
    const b = resolve(right, afterDefs, seen.after);
    if (!a || !b) return;
    const x = a.node;
    const y = b.node;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const nextSeen = { before: a.seen, after: b.seen };

    if (x.type !== undefined || y.type !== undefined) {
      const was = asSet(x.type);
      const now = asSet(y.type);
      if ([...was].some((type) => !now.has(type)) && now.size > 0)
        note(ToolSchemaChangeEnum.Breaking, path, "type changed");
      else if ([...now].some((type) => !was.has(type)))
        note(ToolSchemaChangeEnum.Additive, path, "accepts more types");
    }
    if (x.enum !== undefined || y.enum !== undefined) {
      const was = asSet(x.enum);
      const now = asSet(y.enum);
      if (y.enum !== undefined && [...was].some((value) => !now.has(value))) {
        note(ToolSchemaChangeEnum.Breaking, path, "allowed values removed");
      } else if (y.enum === undefined || [...now].some((value) => !was.has(value))) {
        note(ToolSchemaChangeEnum.Additive, path, "more values allowed");
      }
    }
    for (const key of LOWER_BOUNDS) {
      if (x[key] === y[key]) continue;
      const tighter =
        typeof y[key] === "number" &&
        (typeof x[key] !== "number" || (y[key] as number) > (x[key] as number));
      note(
        tighter ? ToolSchemaChangeEnum.Breaking : ToolSchemaChangeEnum.Additive,
        path,
        `${key} changed`,
      );
    }
    for (const key of UPPER_BOUNDS) {
      if (x[key] === y[key]) continue;
      const tighter =
        typeof y[key] === "number" &&
        (typeof x[key] !== "number" || (y[key] as number) < (x[key] as number));
      note(
        tighter ? ToolSchemaChangeEnum.Breaking : ToolSchemaChangeEnum.Additive,
        path,
        `${key} changed`,
      );
    }
    for (const key of STRICT_KEYWORDS) {
      if (JSON.stringify(x[key]) === JSON.stringify(y[key])) continue;
      note(
        y[key] === undefined ? ToolSchemaChangeEnum.Additive : ToolSchemaChangeEnum.Breaking,
        path,
        `${key} changed`,
      );
    }
    for (const key of UNION_KEYWORDS) {
      const was = x[key];
      const now = y[key];
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      if (Array.isArray(was) && Array.isArray(now) && was.length === now.length) {
        was.forEach((member, index) =>
          compare(member, now[index], `${path}|${index}`, depth + 1, nextSeen),
        );
      } else note(ToolSchemaChangeEnum.Breaking, path, `${key} changed`);
    }

    const wasProperties = isNode(x.properties) ? x.properties : {};
    const nowProperties = isNode(y.properties) ? y.properties : {};
    const wasRequired = new Set((x.required as string[] | undefined) ?? []);
    const nowRequired = new Set((y.required as string[] | undefined) ?? []);
    const child = (name: string) => (path ? `${path}.${name}` : name);
    for (const name of Object.keys(wasProperties)) {
      if (!Object.hasOwn(nowProperties, name))
        note(ToolSchemaChangeEnum.Breaking, child(name), "removed");
    }
    for (const [name, property] of Object.entries(nowProperties)) {
      if (!Object.hasOwn(wasProperties, name)) {
        note(
          nowRequired.has(name) ? ToolSchemaChangeEnum.Breaking : ToolSchemaChangeEnum.Additive,
          child(name),
          nowRequired.has(name) ? "new required field" : "new optional field",
        );
        continue;
      }
      if (nowRequired.has(name) && !wasRequired.has(name))
        note(ToolSchemaChangeEnum.Breaking, child(name), "now required");
      if (!nowRequired.has(name) && wasRequired.has(name))
        note(ToolSchemaChangeEnum.Additive, child(name), "now optional");
      compare(wasProperties[name], property, child(name), depth + 1, nextSeen);
    }
    for (const key of ["items", "additionalProperties"]) {
      if (x[key] === undefined && y[key] === undefined) continue;
      if (y[key] === false && x[key] !== false)
        note(ToolSchemaChangeEnum.Breaking, path, `${key} closed`);
      else if (isNode(x[key]) && isNode(y[key]))
        compare(x[key], y[key], key === "items" ? `${path}[]` : `${path}.*`, depth + 1, nextSeen);
      else if (JSON.stringify(x[key]) !== JSON.stringify(y[key]))
        note(ToolSchemaChangeEnum.Additive, path, `${key} changed`);
    }
    if (
      change === ToolSchemaChangeEnum.None &&
      (x.description !== y.description || x.default !== y.default)
    ) {
      note(ToolSchemaChangeEnum.Additive, path, "description or default changed");
    }
  };

  compare(before, after, "", 0, { before: new Set(), after: new Set() });
  if (change === ToolSchemaChangeEnum.None && JSON.stringify(before) !== JSON.stringify(after)) {
    note(ToolSchemaChangeEnum.Additive, "", "schema text changed");
  }
  return { change, notes };
}
