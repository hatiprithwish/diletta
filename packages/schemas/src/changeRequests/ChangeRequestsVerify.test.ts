import { describe, it, expect } from "vitest";
import { HostCallOutcomeEnum } from "../hostAdapter/HostAdapterCommon";
import type { ToolReadbackOp } from "../toolDefinitions/ToolOpsRegistry";
import { ToolOpMethodEnum } from "../toolDefinitions/ToolOpsV1";
import { ChangeRequestKindEnum, parseChangeRequestPayload } from "./ChangeRequestsCommon";
import {
  ChangeRequestCheckStepEnum,
  ChangeRequestCheckVerdictEnum,
  checkReadAfter,
  getChangeRequestHostRef,
} from "./ChangeRequestsVerify";

const updateReadback: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{args.recordId}",
  compare: { amount: "data.amount", status: "data.status" },
};
const createReadback: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{result.data.id}",
  compare: { amount: "data.amount" },
};
const deleteReadback: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{args.recordId}",
  compare: { recordId: "data.id" },
};

const payload = {
  args: { recordId: "r1", amount: 300 },
  before: { data: { id: "r1", amount: 120, status: "active" } },
};
const answered = (body: unknown) => ({
  outcome: HostCallOutcomeEnum.Succeeded,
  httpStatus: 200,
  body,
});
const gone = { outcome: HostCallOutcomeEnum.Refused, httpStatus: 404 };

const check = (
  kind: ChangeRequestKindEnum,
  step: ChangeRequestCheckStepEnum,
  readbackOp: ToolReadbackOp,
  readback: Parameters<typeof checkReadAfter>[0]["readback"],
) => checkReadAfter({ kind, step, readbackOp, payload, readback });

describe("checkReadAfter after a commit", () => {
  it("matches an update that reads back as the args set it (only the fields the args set)", () => {
    expect(
      check(
        ChangeRequestKindEnum.Update,
        ChangeRequestCheckStepEnum.Commit,
        updateReadback,
        answered({ data: { id: "r1", amount: 300, status: "archived" } }),
      ),
    ).toEqual({ verdict: ChangeRequestCheckVerdictEnum.Matches, mismatches: [] });
  });

  it("names each field that reads back otherwise, with what it found", () => {
    expect(
      check(
        ChangeRequestKindEnum.Update,
        ChangeRequestCheckStepEnum.Commit,
        updateReadback,
        answered({ data: { id: "r1" } }),
      ),
    ).toEqual({
      verdict: ChangeRequestCheckVerdictEnum.Differs,
      mismatches: [
        { field: "amount", expected: { isFound: true, value: 300 }, found: { isFound: false } },
      ],
    });
  });

  it("never calls a read that failed, answered otherwise or has nothing to compare a mismatch", () => {
    for (const readback of [
      { outcome: HostCallOutcomeEnum.Unknown },
      { outcome: HostCallOutcomeEnum.TokenRejected, httpStatus: 401 },
      gone,
      { outcome: HostCallOutcomeEnum.Succeeded, httpStatus: 200 },
    ]) {
      expect(
        check(
          ChangeRequestKindEnum.Update,
          ChangeRequestCheckStepEnum.Commit,
          updateReadback,
          readback,
        ).verdict,
      ).toBe(ChangeRequestCheckVerdictEnum.Unknown);
    }
    expect(
      checkReadAfter({
        kind: ChangeRequestKindEnum.Update,
        step: ChangeRequestCheckStepEnum.Commit,
        readbackOp: updateReadback,
        payload: { args: { recordId: "r1" }, before: null },
        readback: answered({ data: { id: "r1" } }),
      }).verdict,
    ).toBe(ChangeRequestCheckVerdictEnum.Unknown);
  });

  it("matches a delete only once the record is gone (404)", () => {
    const deleted = (readback: Parameters<typeof check>[3]) =>
      check(
        ChangeRequestKindEnum.Delete,
        ChangeRequestCheckStepEnum.Commit,
        deleteReadback,
        readback,
      );
    expect(deleted(gone).verdict).toBe(ChangeRequestCheckVerdictEnum.Matches);
    expect(deleted(answered({ data: { id: "r1" } }))).toEqual({
      verdict: ChangeRequestCheckVerdictEnum.Differs,
      mismatches: [
        { field: "recordId", expected: { isFound: false }, found: { isFound: true, value: "r1" } },
      ],
    });
    expect(deleted({ outcome: HostCallOutcomeEnum.Failed }).verdict).toBe(
      ChangeRequestCheckVerdictEnum.Unknown,
    );
  });
});

describe("checkReadAfter after an undo", () => {
  it("matches an update put back to its read-before values", () => {
    expect(
      check(
        ChangeRequestKindEnum.Update,
        ChangeRequestCheckStepEnum.Undo,
        updateReadback,
        answered({ data: { id: "r1", amount: 120 } }),
      ).verdict,
    ).toBe(ChangeRequestCheckVerdictEnum.Matches);
    expect(
      check(
        ChangeRequestKindEnum.Update,
        ChangeRequestCheckStepEnum.Undo,
        updateReadback,
        answered({ data: { id: "r1", amount: 300 } }),
      ).verdict,
    ).toBe(ChangeRequestCheckVerdictEnum.Differs);
  });

  it("matches a created record removed again, and a deleted one put back", () => {
    expect(
      check(ChangeRequestKindEnum.Create, ChangeRequestCheckStepEnum.Undo, createReadback, gone)
        .verdict,
    ).toBe(ChangeRequestCheckVerdictEnum.Matches);
    expect(
      check(
        ChangeRequestKindEnum.Delete,
        ChangeRequestCheckStepEnum.Undo,
        deleteReadback,
        answered({ data: { id: "r1" } }),
      ).verdict,
    ).toBe(ChangeRequestCheckVerdictEnum.Matches);
  });
});

describe("getChangeRequestHostRef", () => {
  it("reads the created record's id from the result at the readback path's placeholder", () => {
    expect(getChangeRequestHostRef(createReadback, { data: { id: "rec_new" } })).toBe("rec_new");
    expect(getChangeRequestHostRef(createReadback, { data: { id: 42 } })).toBe("42");
    expect(getChangeRequestHostRef(createReadback, { data: {} })).toBeNull();
    expect(getChangeRequestHostRef(createReadback, null)).toBeNull();
    expect(getChangeRequestHostRef(updateReadback, { data: { id: "r1" } })).toBeNull();
  });
});

describe("parseChangeRequestPayload", () => {
  it("upgrades a v1 payload with no result or mismatches yet, and refuses anything else", () => {
    const v1 = {
      version: 1,
      kind: ChangeRequestKindEnum.Update,
      args: { recordId: "r1" },
      before: null,
      changes: [],
    };
    expect(parseChangeRequestPayload(v1)).toEqual({
      ...v1,
      version: 2,
      result: null,
      mismatches: null,
    });
    const v2 = { ...v1, version: 2, result: { data: { id: "r1" } }, mismatches: [] };
    expect(parseChangeRequestPayload(v2)).toEqual(v2);
    expect(parseChangeRequestPayload({ ...v1, version: 3 })).toBeNull();
    expect(parseChangeRequestPayload("not a payload")).toBeNull();
  });
});
