import { describe, it, expect } from "vitest";
import {
  compareReadback,
  getCommitCheckExpectations,
  getCommitExpectations,
  getUndoCheckExpectations,
  getUndoExpectations,
} from "./ToolReadbackCompare";
import type { ToolReadbackOp } from "./ToolOpsRegistry";
import { ToolOpMethodEnum } from "./ToolOpsV1";

const readbackOp: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{args.recordId}",
  compare: { amount: "data.amount", tags: "data.tags", owner: "data.owner" },
};

describe("getCommitExpectations", () => {
  it("expects every compare field the args set, and skips omitted args", () => {
    expect(
      getCommitExpectations(readbackOp, { recordId: "r1", amount: 12.5, tags: ["a"] }),
    ).toEqual([
      { name: "amount", path: "data.amount", expected: { isFound: true, value: 12.5 } },
      { name: "tags", path: "data.tags", expected: { isFound: true, value: ["a"] } },
    ]);
  });

  it("keeps a null arg (it clears the field)", () => {
    expect(getCommitExpectations(readbackOp, { owner: null })).toEqual([
      { name: "owner", path: "data.owner", expected: { isFound: true, value: null } },
    ]);
  });
});

describe("getUndoExpectations", () => {
  it("expects the before values of the fields the write set, absent stays absent", () => {
    const before = { data: { amount: 10, tags: ["x"] } };
    expect(getUndoExpectations(readbackOp, { amount: 12.5, owner: { id: 1 } }, before)).toEqual([
      { name: "amount", path: "data.amount", expected: { isFound: true, value: 10 } },
      { name: "owner", path: "data.owner", expected: { isFound: false } },
    ]);
  });
});

describe("getCommitCheckExpectations / getUndoCheckExpectations", () => {
  const args = { amount: 12.5 };
  const before = { data: { amount: 10 } };
  const sent = [{ name: "amount", path: "data.amount", expected: { isFound: true, value: 12.5 } }];
  const earlier = [{ name: "amount", path: "data.amount", expected: { isFound: true, value: 10 } }];

  it("a commit lands as the args over the read-before values", () => {
    expect(getCommitCheckExpectations(readbackOp, args, before)).toEqual({
      landed: sent,
      notLanded: earlier,
    });
  });

  it("an undo swaps them", () => {
    expect(getUndoCheckExpectations(readbackOp, args, before)).toEqual({
      landed: earlier,
      notLanded: sent,
    });
  });
});

describe("compareReadback", () => {
  const expectations = getCommitExpectations(readbackOp, {
    amount: 12.5,
    tags: ["a", "b"],
    owner: { id: 1, name: "Ana" },
  });

  it("matches JSON values regardless of key order", () => {
    const response = { data: { owner: { name: "Ana", id: 1 }, tags: ["a", "b"], amount: 12.5 } };
    expect(compareReadback(expectations, response)).toEqual({
      isMatch: true,
      fields: [
        { name: "amount", isMatch: true },
        { name: "tags", isMatch: true },
        { name: "owner", isMatch: true },
      ],
    });
  });

  it("reports each field that differs", () => {
    const response = {
      data: { amount: "12.5", tags: ["b", "a"], owner: { id: 1, name: "Ana", x: 1 } },
    };
    expect(compareReadback(expectations, response)).toEqual({
      isMatch: false,
      fields: [
        { name: "amount", isMatch: false },
        { name: "tags", isMatch: false },
        { name: "owner", isMatch: false },
      ],
    });
  });

  it("matches an absent field only when it is expected absent", () => {
    const undo = getUndoExpectations(readbackOp, { owner: "x" }, { data: {} });
    expect(compareReadback(undo, { data: {} }).isMatch).toBe(true);
    expect(compareReadback(undo, { data: { owner: null } }).isMatch).toBe(false);
    expect(compareReadback(expectations, { data: { amount: 12.5 } }).isMatch).toBe(false);
  });

  it("never matches with nothing to compare", () => {
    expect(compareReadback([], { data: {} })).toEqual({ isMatch: false, fields: [] });
  });
});
