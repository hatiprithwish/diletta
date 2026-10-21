import { z } from "zod";
import {
  readsCallResult,
  ToolDefinitionRiskIntEnum,
} from "../toolDefinitions/ToolDefinitionsCommon";
import {
  ToolOpPlaceholderRootEnum,
  collectTemplateStrings,
  findToolOpPlaceholders,
  readValueAtPath,
} from "../toolDefinitions/ToolOpPlaceholders";
import type { ToolInputSchema } from "../toolDefinitions/ToolArgsValidator";
import type { ToolCallOp, ToolReadbackOp } from "../toolDefinitions/ToolOpsRegistry";
import { isJsonEqual } from "../toolDefinitions/ToolReadbackCompare";
import {
  ChangeRequestFieldTypeEnum,
  ChangeRequestKindEnum,
  type ChangeRequestChange,
  type ChangeRequestEditableField,
  type ChangeRequestEditValues,
  type ChangeRequestValue,
} from "./ChangeRequestsCommon";

// DEV_NOTE: The approval diff (M3-4): built from the read-before response and the validated args through the
// readback op's compare map (compare key = arg name, value = dot path into the response), never from anything the
// model wrote about the change. Every arg the commit sends is on it, so the user approves exactly what goes out: the
// compare fields, then any other arg call_op sends in its query or body (its stored value can't be read back, so it
// shows as set, always a change), then the args that only pick the record (call_op path), shown unchanged. Pure;
// nothing here throws.

// DEV_NOTE: A Write whose readback reads {result.*} has no read-before (the record exists only after the call): it
// creates. Any other Write updates, a Destructive tool deletes.
export function getChangeRequestKind(
  risk: ToolDefinitionRiskIntEnum.Write | ToolDefinitionRiskIntEnum.Destructive,
  readbackOp: ToolReadbackOp,
): ChangeRequestKindEnum {
  if (risk === ToolDefinitionRiskIntEnum.Destructive) return ChangeRequestKindEnum.Delete;
  return readsCallResult(readbackOp) ? ChangeRequestKindEnum.Create : ChangeRequestKindEnum.Update;
}

export const hasReadBefore = (kind: ChangeRequestKindEnum): boolean =>
  kind !== ChangeRequestKindEnum.Create;

const ABSENT: ChangeRequestValue = { isFound: false };

// Host values arrive as parsed JSON; one that isn't JSON (never expected) reads as absent rather than throwing
function toChangeValue(value: unknown): ChangeRequestValue {
  const parsed = z.json().safeParse(value);
  return parsed.success ? { isFound: true, value: parsed.data } : ABSENT;
}

// DEV_NOTE: The args call_op reads ({args.<name>}): in its path (they pick the record) and in its query or body (they
// are sent as values). One read in both counts as sent.
function getCallOpArgs(callOp: ToolCallOp): { pathArgs: Set<string>; sentArgs: Set<string> } {
  const argNamesIn = (value: unknown): Set<string> => {
    const strings: { text: string; path: (string | number)[] }[] = [];
    collectTemplateStrings(value, [], strings);
    return new Set(
      strings.flatMap(({ text }) =>
        findToolOpPlaceholders(text)
          .filter((placeholder) => placeholder.root === ToolOpPlaceholderRootEnum.Args)
          .map((placeholder) => placeholder.segments[0] ?? ""),
      ),
    );
  };
  const sentArgs = new Set([...argNamesIn(callOp.query), ...argNamesIn(callOp.bodyMap)]);
  const pathArgs = new Set([...argNamesIn(callOp.path)].filter((name) => !sentArgs.has(name)));
  return { pathArgs, sentArgs };
}

const hasArg = (args: Record<string, unknown>, name: string): boolean =>
  Object.hasOwn(args, name) && args[name] !== undefined;

// DEV_NOTE: Update: every compare field the model passed an arg for, before = the read-before value at its path, after
// = the arg. Create: the same fields, nothing before. Delete: every compare field, before = what the read-before shows,
// after = absent (the record goes). Then, for every kind, the other args call_op sends (before unknown: absent, always
// a change; for a delete, only when the record was found) and the args that only pick the record (before = after = the arg, never a change).
export function buildChangeRequestChanges(params: {
  kind: ChangeRequestKindEnum;
  callOp: ToolCallOp;
  readbackOp: ToolReadbackOp;
  args: Record<string, unknown>;
  before: unknown;
}): ChangeRequestChange[] {
  const { kind, callOp, readbackOp, args, before } = params;
  const compare = Object.entries(readbackOp.compare);
  const compareFields = new Set(compare.map(([field]) => field));
  const { pathArgs, sentArgs } = getCallOpArgs(callOp);

  const compared: ChangeRequestChange[] =
    kind === ChangeRequestKindEnum.Delete
      ? compare.map(([field, path]) => {
          const found = readValueAtPath(before, path.split("."));
          const beforeValue = found.isFound ? toChangeValue(found.value) : ABSENT;
          return { field, before: beforeValue, after: ABSENT, isChanged: beforeValue.isFound };
        })
      : compare
          .filter(([field]) => hasArg(args, field))
          .map(([field, path]) => {
            const after = toChangeValue(args[field]);
            if (kind === ChangeRequestKindEnum.Create) {
              return { field, before: ABSENT, after, isChanged: true };
            }
            const found = readValueAtPath(before, path.split("."));
            const beforeValue = found.isFound ? toChangeValue(found.value) : ABSENT;
            const isChanged = !(
              beforeValue.isFound &&
              after.isFound &&
              isJsonEqual(beforeValue.value, after.value)
            );
            return { field, before: beforeValue, after, isChanged };
          });

  const uncompared = (names: Set<string>) =>
    Object.keys(args).filter(
      (field) => names.has(field) && !compareFields.has(field) && hasArg(args, field),
    );
  // DEV_NOTE: A delete whose record wasn't found deletes nothing, whatever else it would send
  const isSentChange =
    kind !== ChangeRequestKindEnum.Delete || compared.some((change) => change.isChanged);
  const sent = uncompared(sentArgs).map((field) => ({
    field,
    before: ABSENT,
    after: toChangeValue(args[field]),
    isChanged: isSentChange,
  }));
  const picking = uncompared(pathArgs).map((field) => {
    const value = toChangeValue(args[field]);
    return { field, before: value, after: value, isChanged: false };
  });
  return [...compared, ...sent, ...picking];
}

export const countChangedFields = (changes: ChangeRequestChange[]): number =>
  changes.filter((change) => change.isChanged).length;

// DEV_NOTE: change_requests.summary: for lists, so no values, only the tool and the shape of the change
export function buildChangeRequestSummary(
  toolName: string,
  kind: ChangeRequestKindEnum,
  changeCount: number,
): string {
  const fields = `${changeCount} ${changeCount === 1 ? "field" : "fields"}`;
  switch (kind) {
    case ChangeRequestKindEnum.Create:
      return `${toolName}: new record, ${fields}`;
    case ChangeRequestKindEnum.Delete:
      return `${toolName}: delete record`;
    case ChangeRequestKindEnum.Update:
      return `${toolName}: ${fields} changed`;
  }
}

// DEV_NOTE: The fields the user may edit on a proposal (M3-5): the args call_op sends in its query or body, never the
// args that only pick the record (path), and none for a delete (it sends nothing to change). Each must have one scalar
// type in input_schema (a nullable type counts as that type); an object, an array, a $ref or a union isn't editable.
// In input_schema property order.
export function getEditableFields(params: {
  kind: ChangeRequestKindEnum;
  callOp: ToolCallOp;
  inputSchema: ToolInputSchema;
}): ChangeRequestEditableField[] {
  if (params.kind === ChangeRequestKindEnum.Delete) return [];
  const { sentArgs } = getCallOpArgs(params.callOp);
  const required = new Set(params.inputSchema.required ?? []);
  return Object.entries(params.inputSchema.properties).flatMap(([field, property]) => {
    if (!sentArgs.has(field)) return [];
    const type = scalarTypeOf(property);
    if (!type) return [];
    return [
      {
        field,
        type,
        enumValues: enumValuesOf(property),
        format: typeof property.format === "string" ? property.format : null,
        isRequired: required.has(field),
      },
    ];
  });
}

const SCALAR_TYPES = new Set<string>(Object.values(ChangeRequestFieldTypeEnum));

function scalarTypeOf(property: Record<string, unknown>): ChangeRequestFieldTypeEnum | null {
  const declared = property.type;
  const types = (Array.isArray(declared) ? declared : [declared]).filter(
    (type) => type !== "null" && type !== undefined,
  );
  if (types.length === 0) {
    // DEV_NOTE: An enum with no type: its values' type, when they share one
    const values = enumValuesOf(property);
    const kinds = new Set(values?.map((value) => typeof value));
    if (kinds.size !== 1) return null;
    const [kind] = [...kinds];
    return kind === "string"
      ? ChangeRequestFieldTypeEnum.String
      : kind === "number"
        ? ChangeRequestFieldTypeEnum.Number
        : kind === "boolean"
          ? ChangeRequestFieldTypeEnum.Boolean
          : null;
  }
  const [type] = types;
  if (types.length !== 1 || typeof type !== "string" || !SCALAR_TYPES.has(type)) return null;
  return type as ChangeRequestFieldTypeEnum;
}

function enumValuesOf(property: Record<string, unknown>): (string | number | boolean)[] | null {
  const values = property.enum;
  if (!Array.isArray(values)) return null;
  const scalars = values.filter(
    (value): value is string | number | boolean =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
  return scalars.length > 0 ? scalars : null;
}

// DEV_NOTE: The args an edit would send: the stored args with the edited values on top. Refused when it names a field
// that isn't editable. The result still has to pass the input_schema (validateToolArgs) before anything uses it.
export function applyChangeRequestEdits(params: {
  args: Record<string, unknown>;
  values: ChangeRequestEditValues;
  editableFields: ChangeRequestEditableField[];
}): { isSuccess: true; args: Record<string, unknown> } | { isSuccess: false; message: string } {
  const editable = new Set(params.editableFields.map((field) => field.field));
  const locked = Object.keys(params.values).filter((field) => !editable.has(field));
  if (locked.length > 0) {
    return { isSuccess: false, message: `Not editable: ${locked.join(", ")}` };
  }
  return { isSuccess: true, args: { ...params.args, ...params.values } };
}
