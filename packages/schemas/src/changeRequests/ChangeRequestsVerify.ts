import { HostCallOutcomeEnum, type HostCallResponse } from "../hostAdapter/HostAdapterCommon";
import {
  ToolOpPlaceholderRootEnum,
  findToolOpPlaceholders,
  readValueAtPath,
  type ReadValueAtPathResult,
} from "../toolDefinitions/ToolOpPlaceholders";
import type { ToolReadbackOp } from "../toolDefinitions/ToolOpsRegistry";
import {
  compareReadback,
  getCommitExpectations,
  getUndoExpectations,
  type ReadbackExpectation,
} from "../toolDefinitions/ToolReadbackCompare";
import {
  ChangeRequestKindEnum,
  ZChangeRequestValue,
  type ChangeRequestMismatch,
  type ChangeRequestPayload,
  type ChangeRequestValue,
} from "./ChangeRequestsCommon";

// DEV_NOTE: The read-after (M3-6): after a commit lands, the tool's readback_op is read again as the user and must show
// what the commit set; after an auto-undo, what the record held before. Pure, so the eval harness's readback asserts
// can check the same way. Nothing here throws.
//   Commit of an update or a create: every compare field the args set reads back as the arg's value.
//   Commit of a delete, undo of a create: the record is gone (the readback answers 404).
//   Undo of an update or a delete: every compare field the args set reads back as the read-before showed it.
// Matches / Differs / Unknown: anything that can't tell (the read failed, answered something else, nothing to
// compare) is Unknown, never Differs, so an unknown never triggers an undo.
export enum ChangeRequestCheckStepEnum {
  Commit = "commit",
  Undo = "undo",
}

export enum ChangeRequestCheckVerdictEnum {
  Matches = "matches",
  Differs = "differs",
  Unknown = "unknown",
}

export interface ChangeRequestReadAfterCheck {
  verdict: ChangeRequestCheckVerdictEnum;
  // The fields that read back otherwise (Differs only, else empty)
  mismatches: ChangeRequestMismatch[];
}

const GONE_HTTP_STATUS = 404;

// DEV_NOTE: After this step the record no longer exists
export function isRecordGoneAfter(
  kind: ChangeRequestKindEnum,
  step: ChangeRequestCheckStepEnum,
): boolean {
  return step === ChangeRequestCheckStepEnum.Commit
    ? kind === ChangeRequestKindEnum.Delete
    : kind === ChangeRequestKindEnum.Create;
}

// DEV_NOTE: A value read from a JSON response (or the args) as a diff value; anything that isn't JSON reads as absent
const toValue = (found: ReadValueAtPathResult): ChangeRequestValue => {
  if (!found.isFound) return { isFound: false };
  const parsed = ZChangeRequestValue.safeParse({ isFound: true, value: found.value });
  return parsed.success ? parsed.data : { isFound: false };
};

const expectedValue = (expectation: ReadbackExpectation): ChangeRequestValue =>
  toValue(expectation.expected);

export function checkReadAfter(params: {
  kind: ChangeRequestKindEnum;
  step: ChangeRequestCheckStepEnum;
  readbackOp: ToolReadbackOp;
  payload: Pick<ChangeRequestPayload, "args" | "before">;
  readback: Pick<HostCallResponse, "outcome" | "httpStatus" | "body">;
}): ChangeRequestReadAfterCheck {
  const { kind, step, readbackOp, payload, readback } = params;
  const unknown = { verdict: ChangeRequestCheckVerdictEnum.Unknown, mismatches: [] };

  if (isRecordGoneAfter(kind, step)) {
    if (
      readback.outcome === HostCallOutcomeEnum.Refused &&
      readback.httpStatus === GONE_HTTP_STATUS
    ) {
      return { verdict: ChangeRequestCheckVerdictEnum.Matches, mismatches: [] };
    }
    if (readback.outcome !== HostCallOutcomeEnum.Succeeded) return unknown;
    // DEV_NOTE: The record is still there: each compare field shows what it holds where nothing was expected
    const expectations = getCommitExpectations(readbackOp, payload.args);
    return {
      verdict: ChangeRequestCheckVerdictEnum.Differs,
      mismatches: expectations.map(({ name, path }) => ({
        field: name,
        expected: { isFound: false },
        found: toValue(readValueAtPath(readback.body, path.split("."))),
      })),
    };
  }

  if (readback.outcome !== HostCallOutcomeEnum.Succeeded || readback.body === undefined) {
    return unknown;
  }
  const expectations =
    step === ChangeRequestCheckStepEnum.Commit
      ? getCommitExpectations(readbackOp, payload.args)
      : getUndoExpectations(readbackOp, payload.args, payload.before);
  if (expectations.length === 0) return unknown;
  const compared = compareReadback(expectations, readback.body);
  if (compared.isMatch) return { verdict: ChangeRequestCheckVerdictEnum.Matches, mismatches: [] };
  const failed = new Set(compared.fields.filter((field) => !field.isMatch).map((f) => f.name));
  return {
    verdict: ChangeRequestCheckVerdictEnum.Differs,
    mismatches: expectations
      .filter((expectation) => failed.has(expectation.name))
      .map((expectation) => ({
        field: expectation.name,
        expected: expectedValue(expectation),
        found: toValue(readValueAtPath(readback.body, expectation.path.split("."))),
      })),
  };
}

// DEV_NOTE: change_requests.host_ref: the id the host gave a created record, i.e. the value at the first {result.*}
// placeholder of the readback path (the path that reads the new record back). null for an update or a delete (the
// args already name the record), or when the result doesn't hold a string or number there.
export function getChangeRequestHostRef(
  readbackOp: ToolReadbackOp,
  result: unknown,
): string | null {
  const placeholder = findToolOpPlaceholders(readbackOp.path).find(
    (item) => item.root === ToolOpPlaceholderRootEnum.Result,
  );
  if (!placeholder) return null;
  const found = readValueAtPath(result, placeholder.segments);
  if (!found.isFound) return null;
  if (typeof found.value === "string" && found.value.length > 0) return found.value;
  if (typeof found.value === "number" && Number.isFinite(found.value)) return String(found.value);
  return null;
}
