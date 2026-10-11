import { z } from "zod";
import {
  readsCallResult,
  ToolDefinitionRiskIntEnum,
} from "../toolDefinitions/ToolDefinitionsCommon";
import { readValueAtPath } from "../toolDefinitions/ToolOpPlaceholders";
import type { ToolReadbackOp } from "../toolDefinitions/ToolOpsRegistry";
import { isJsonEqual } from "../toolDefinitions/ToolReadbackCompare";
import {
  ChangeRequestKindEnum,
  type ChangeRequestChange,
  type ChangeRequestValue,
} from "./ChangeRequestsCommon";

// DEV_NOTE: The approval diff (M3-4): built from the read-before response and the validated args through the
// readback op's compare map (compare key = arg name, value = dot path into the response), never from anything the
// model wrote about the change. Pure; nothing here throws.

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

// DEV_NOTE: Update: every compare field the model passed an arg for, before = the read-before value at its path, after
// = the arg. Create: the same fields, nothing before. Delete: every compare field, before = what the read-before shows,
// after = absent (the record goes).
export function buildChangeRequestChanges(params: {
  kind: ChangeRequestKindEnum;
  readbackOp: ToolReadbackOp;
  args: Record<string, unknown>;
  before: unknown;
}): ChangeRequestChange[] {
  const { kind, readbackOp, args, before } = params;
  const compare = Object.entries(readbackOp.compare);

  if (kind === ChangeRequestKindEnum.Delete) {
    return compare.map(([field, path]) => {
      const found = readValueAtPath(before, path.split("."));
      const beforeValue = found.isFound ? toChangeValue(found.value) : ABSENT;
      return { field, before: beforeValue, after: ABSENT, isChanged: beforeValue.isFound };
    });
  }

  return compare
    .filter(([field]) => Object.hasOwn(args, field) && args[field] !== undefined)
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
