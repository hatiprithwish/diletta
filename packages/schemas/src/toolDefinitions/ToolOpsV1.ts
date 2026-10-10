import { z } from "zod";
import {
  TOOL_OP_DOT_PATH_PATTERN,
  ToolOpPlaceholderRootEnum,
  findToolOpPlaceholders,
  findMalformedToolOpPlaceholders,
  findUnknownToolOpRoots,
} from "./ToolOpPlaceholders";

// DEV_NOTE: A tool_definitions row's ops (input_schema, call_op, readback_op, inverse_op) at schema_version 1. A frozen
// shape: a breaking change adds ZToolOpsV2 and an upgrader from this version (ToolOpsRegistry), it never edits this
// file. Strict objects, so a misspelt or stale key is rejected instead of silently dropped. Keys are camelCase like
// the config spec body. Paths are relative to the connection's base_url; auth headers come from the AuthStrategy
// (M3-2), so an op names no headers.

export enum ToolOpMethodEnum {
  Get = "GET",
  Post = "POST",
  Put = "PUT",
  Patch = "PATCH",
  Delete = "DELETE",
}

// An input_schema property name, and so a compare key and an {args.<name>} root segment
export const TOOL_ARG_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ZToolArgName = z.string().regex(TOOL_ARG_NAME_PATTERN, "Invalid argument name");

// DEV_NOTE: A path template: starts with "/", no scheme or host (the connection's base_url is the only origin), no
// "." / ".." segment, no query string or fragment (query goes in `query`). renderToolOp re-checks the rendered path,
// since a placeholder value could be "..".
export const ZToolOpPathV1 = z
  .string()
  .min(1)
  .max(2_048)
  .refine((path) => path.startsWith("/") && !path.startsWith("//"), {
    message: "Path must start with a single /",
  })
  .refine((path) => !/[?#\s]/.test(path), { message: "Path has no query, fragment or whitespace" })
  .refine((path) => !path.split("/").some((segment) => segment === "." || segment === ".."), {
    message: "Path has no . or .. segment",
  })
  .refine(
    (path) => {
      const inner = path.endsWith("/") ? path.slice(1, -1) : path.slice(1);
      return path === "/" || !inner.split("/").includes("");
    },
    { message: "Path has no empty segment (only a trailing /)" },
  );

// Query values are strings (a template, or one placeholder whose value is a scalar)
export const ZToolOpQueryV1 = z.record(z.string().min(1).max(200), z.string().max(2_048));

// DEV_NOTE: A JSON body template. Every string leaf may hold placeholders; a leaf that is exactly one placeholder takes
// the value's JSON type ({args.amount} → 12.5), any other string is rendered as text.
export const ZToolOpBodyMapV1 = z.record(z.string().min(1).max(200), z.json());

export const ZToolCallOpV1 = z.strictObject({
  method: z.enum(ToolOpMethodEnum),
  path: ZToolOpPathV1,
  query: ZToolOpQueryV1.optional(),
  bodyMap: ZToolOpBodyMapV1.optional(),
});

// DEV_NOTE: Writes only (read-before + read-after, CHK_tool_definitions_readback_op). Always a GET, since the
// read-before runs before the user approves. compare: arg name → dot path into the readback response; the expected
// value is args[name].
export const ZToolReadbackOpV1 = z.strictObject({
  method: z.literal(ToolOpMethodEnum.Get),
  path: ZToolOpPathV1,
  query: ZToolOpQueryV1.optional(),
  compare: z
    .record(ZToolArgName, z.string().regex(TOOL_OP_DOT_PATH_PATTERN, "Invalid response path"))
    .refine((compare) => Object.keys(compare).length > 0, {
      message: "compare needs at least one field",
    }),
});

// Restores the before state: may read {before.*} and {result.*} too. null = not undoable
export const ZToolInverseOpV1 = ZToolCallOpV1;

// DEV_NOTE: input_schema is JSON Schema (draft 2020-12) shown to the model as the tool's parameters. Only the top level
// is constrained here: an object with named properties, required ⊆ properties. The rest of the vocabulary passes
// through (loose object), since providers accept the standard keywords.
export const ZToolInputSchemaV1 = z
  .looseObject({
    type: z.literal("object"),
    properties: z.record(ZToolArgName, z.record(z.string(), z.json())),
    required: z.array(ZToolArgName).optional(),
  })
  .superRefine((schema, ctx) => {
    const names = Object.keys(schema.properties);
    if (names.length > 100) {
      ctx.addIssue({ code: "custom", message: "At most 100 properties", path: ["properties"] });
    }
    schema.required?.forEach((name, index) => {
      if (!names.includes(name)) {
        ctx.addIssue({
          code: "custom",
          message: `Required "${name}" is not a property`,
          path: ["required", index],
        });
      }
    });
  });

// Every string in a template value with its path, for the reference checks
function collectStrings(
  value: unknown,
  path: (string | number)[],
  out: { text: string; path: (string | number)[] }[],
) {
  if (typeof value === "string") {
    out.push({ text: value, path });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, [...path, index], out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectStrings(item, [...path, key], out);
  }
}

// DEV_NOTE: Which placeholder roots each op may read. call_op runs first, so it has the model's args only. readback_op
// runs before the call (read-before) and after it (read-after), so {result.*} is there only after; a readback that
// needs the call's result (a created record's id) has no read-before (M3-4). inverse_op runs after both.
const ALLOWED_ROOTS: Record<"callOp" | "readbackOp" | "inverseOp", ToolOpPlaceholderRootEnum[]> = {
  callOp: [ToolOpPlaceholderRootEnum.Args],
  readbackOp: [ToolOpPlaceholderRootEnum.Args, ToolOpPlaceholderRootEnum.Result],
  inverseOp: [
    ToolOpPlaceholderRootEnum.Args,
    ToolOpPlaceholderRootEnum.Before,
    ToolOpPlaceholderRootEnum.Result,
  ],
};

export const ZToolOpsV1 = z
  .strictObject({
    inputSchema: ZToolInputSchemaV1,
    callOp: ZToolCallOpV1,
    readbackOp: ZToolReadbackOpV1.nullable(),
    inverseOp: ZToolInverseOpV1.nullable(),
  })
  .superRefine((ops, ctx) => {
    const argNames = Object.keys(ops.inputSchema.properties);

    for (const opKey of ["callOp", "readbackOp", "inverseOp"] as const) {
      const op = ops[opKey];
      if (!op) continue;

      const strings: { text: string; path: (string | number)[] }[] = [];
      collectStrings(op.path, [opKey, "path"], strings);
      collectStrings(op.query, [opKey, "query"], strings);
      if ("bodyMap" in op) collectStrings(op.bodyMap, [opKey, "bodyMap"], strings);

      for (const { text, path } of strings) {
        for (const token of findUnknownToolOpRoots(text)) {
          ctx.addIssue({ code: "custom", message: `Unknown placeholder ${token}`, path });
        }
        for (const token of findMalformedToolOpPlaceholders(text)) {
          ctx.addIssue({ code: "custom", message: `Malformed placeholder ${token}`, path });
        }
        for (const placeholder of findToolOpPlaceholders(text)) {
          if (!ALLOWED_ROOTS[opKey].includes(placeholder.root)) {
            ctx.addIssue({
              code: "custom",
              message: `${placeholder.token}: ${opKey} can't read ${placeholder.root}`,
              path,
            });
          } else if (
            placeholder.root === ToolOpPlaceholderRootEnum.Args &&
            !argNames.includes(placeholder.segments[0]!)
          ) {
            ctx.addIssue({
              code: "custom",
              message: `${placeholder.token}: "${placeholder.segments[0]}" is not an input_schema property`,
              path,
            });
          }
        }
      }
    }

    if (ops.readbackOp) {
      for (const name of Object.keys(ops.readbackOp.compare)) {
        if (!argNames.includes(name)) {
          ctx.addIssue({
            code: "custom",
            message: `compare key "${name}" is not an input_schema property`,
            path: ["readbackOp", "compare", name],
          });
        }
      }
    }
  });
export type ToolOpsV1Input = z.input<typeof ZToolOpsV1>;
export type ToolOpsV1 = z.output<typeof ZToolOpsV1>;
export type ToolCallOpV1 = z.output<typeof ZToolCallOpV1>;
export type ToolReadbackOpV1 = z.output<typeof ZToolReadbackOpV1>;
export type ToolInverseOpV1 = z.output<typeof ZToolInverseOpV1>;
