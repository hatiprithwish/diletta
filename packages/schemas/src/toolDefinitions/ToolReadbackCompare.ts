import { readValueAtPath, type ReadValueAtPathResult } from "./ToolOpPlaceholders";
import type { ToolReadbackOp } from "./ToolOpsRegistry";

// DEV_NOTE: What one compare field of a readback must show: the field's arg name, the dot path into the readback
// response, and the expected value (not found = the field must be absent). Values stay in memory: they are host data.
export interface ReadbackExpectation {
  name: string;
  path: string;
  expected: ReadValueAtPathResult;
}

export interface ReadbackComparison {
  // True only when there was at least one field and every field matched
  isMatch: boolean;
  fields: { name: string; isMatch: boolean }[];
}

// DEV_NOTE: The fields a write sets: every compare key the model passed an arg for (an omitted optional arg isn't
// written, so it isn't checked). After a commit (and for the emulated "did it land?" check) each field must read back
// as the arg's value.
export function getCommitExpectations(
  readbackOp: ToolReadbackOp,
  args: Record<string, unknown>,
): ReadbackExpectation[] {
  return Object.entries(readbackOp.compare)
    .filter(([name]) => Object.hasOwn(args, name) && args[name] !== undefined)
    .map(([name, path]) => ({ name, path, expected: { isFound: true, value: args[name] } }));
}

// DEV_NOTE: After an undo, the same fields must read back as they did before the commit: the value at the same path
// in the read-before response (absent there = absent again).
export function getUndoExpectations(
  readbackOp: ToolReadbackOp,
  args: Record<string, unknown>,
  before: unknown,
): ReadbackExpectation[] {
  return getCommitExpectations(readbackOp, args).map(({ name, path }) => ({
    name,
    path,
    expected: readValueAtPath(before, path.split(".")),
  }));
}

// DEV_NOTE: What the Emulated "did it land?" check compares (HostAppliedCheck): landed = the step's own values, notLanded
// = the values the step replaces. A commit sets args over the read-before values; its undo sets the read-before values
// back over args, so the two swap.
export interface ReadbackCheckExpectations {
  landed: ReadbackExpectation[];
  notLanded: ReadbackExpectation[];
}

export function getCommitCheckExpectations(
  readbackOp: ToolReadbackOp,
  args: Record<string, unknown>,
  before: unknown,
): ReadbackCheckExpectations {
  return {
    landed: getCommitExpectations(readbackOp, args),
    notLanded: getUndoExpectations(readbackOp, args, before),
  };
}

export function getUndoCheckExpectations(
  readbackOp: ToolReadbackOp,
  args: Record<string, unknown>,
  before: unknown,
): ReadbackCheckExpectations {
  const commit = getCommitCheckExpectations(readbackOp, args, before);
  return { landed: commit.notLanded, notLanded: commit.landed };
}

// DEV_NOTE: JSON equality: same type, numbers by value, arrays in order, objects by key set regardless of key order
export function isJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => isJsonEqual(item, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(rightRecord, key) &&
      isJsonEqual((left as Record<string, unknown>)[key], rightRecord[key]),
  );
}

// DEV_NOTE: No fields is never a match: a readback that checks nothing can't prove a write landed or was undone
export function compareReadback(
  expectations: ReadbackExpectation[],
  response: unknown,
): ReadbackComparison {
  const fields = expectations.map(({ name, path, expected }) => {
    const actual = readValueAtPath(response, path.split("."));
    const isMatch =
      actual.isFound && expected.isFound
        ? isJsonEqual(actual.value, expected.value)
        : actual.isFound === expected.isFound;
    return { name, isMatch };
  });
  return { isMatch: fields.length > 0 && fields.every((field) => field.isMatch), fields };
}
