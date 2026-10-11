import { describe, it, expect } from "vitest";
import { ToolDefinitionRiskIntEnum } from "../toolDefinitions/ToolDefinitionsCommon";
import type { ToolReadbackOp } from "../toolDefinitions/ToolOpsRegistry";
import { ToolOpMethodEnum } from "../toolDefinitions/ToolOpsV1";
import { ChangeRequestKindEnum } from "./ChangeRequestsCommon";
import {
  buildChangeRequestChanges,
  buildChangeRequestSummary,
  countChangedFields,
  getChangeRequestKind,
  hasReadBefore,
} from "./ChangeRequestsDiff";

const updateReadback: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{args.recordId}",
  compare: { name: "data.name", amount: "data.amount", tags: "data.tags" },
};
const createReadback: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{result.data.id}",
  compare: { name: "data.name", amount: "data.amount" },
};
const deleteReadback: ToolReadbackOp = {
  method: ToolOpMethodEnum.Get,
  path: "/records/{args.recordId}",
  compare: { recordId: "data.id" },
};
const before = { data: { id: "rec_alpha", name: "Alpha", amount: 120, tags: ["a", "b"] } };

describe("getChangeRequestKind", () => {
  it("is a create when the readback reads the call's result, else an update; a destructive tool deletes", () => {
    expect(getChangeRequestKind(ToolDefinitionRiskIntEnum.Write, updateReadback)).toBe(
      ChangeRequestKindEnum.Update,
    );
    expect(getChangeRequestKind(ToolDefinitionRiskIntEnum.Write, createReadback)).toBe(
      ChangeRequestKindEnum.Create,
    );
    expect(getChangeRequestKind(ToolDefinitionRiskIntEnum.Destructive, deleteReadback)).toBe(
      ChangeRequestKindEnum.Delete,
    );
    expect(hasReadBefore(ChangeRequestKindEnum.Create)).toBe(false);
    expect(hasReadBefore(ChangeRequestKindEnum.Update)).toBe(true);
    expect(hasReadBefore(ChangeRequestKindEnum.Delete)).toBe(true);
  });
});

describe("buildChangeRequestChanges", () => {
  it("diffs an update from the read-before and the real args, field by field", () => {
    const changes = buildChangeRequestChanges({
      kind: ChangeRequestKindEnum.Update,
      readbackOp: updateReadback,
      args: { recordId: "rec_alpha", name: "Alpha Two", amount: 120, tags: ["b", "a"] },
      before,
    });
    expect(changes).toEqual([
      {
        field: "name",
        before: { isFound: true, value: "Alpha" },
        after: { isFound: true, value: "Alpha Two" },
        isChanged: true,
      },
      {
        field: "amount",
        before: { isFound: true, value: 120 },
        after: { isFound: true, value: 120 },
        isChanged: false,
      },
      {
        field: "tags",
        before: { isFound: true, value: ["a", "b"] },
        after: { isFound: true, value: ["b", "a"] },
        isChanged: true,
      },
    ]);
    expect(countChangedFields(changes)).toBe(2);
  });

  it("leaves out a compare field the model passed no arg for, and shows a field the record lacks as absent", () => {
    const changes = buildChangeRequestChanges({
      kind: ChangeRequestKindEnum.Update,
      readbackOp: updateReadback,
      args: { recordId: "rec_alpha", amount: 5 },
      before: { data: { id: "rec_alpha" } },
    });
    expect(changes).toEqual([
      {
        field: "amount",
        before: { isFound: false },
        after: { isFound: true, value: 5 },
        isChanged: true,
      },
    ]);
  });

  it("shows a create as new values with nothing before", () => {
    const changes = buildChangeRequestChanges({
      kind: ChangeRequestKindEnum.Create,
      readbackOp: createReadback,
      args: { name: "New", amount: 1 },
      before: null,
    });
    expect(changes.every((change) => change.isChanged && !change.before.isFound)).toBe(true);
    expect(changes.map((change) => change.field)).toEqual(["name", "amount"]);
  });

  it("shows a delete as the record's values going away, and nothing to delete when it wasn't found", () => {
    const found = buildChangeRequestChanges({
      kind: ChangeRequestKindEnum.Delete,
      readbackOp: deleteReadback,
      args: { recordId: "rec_alpha" },
      before,
    });
    expect(found).toEqual([
      {
        field: "recordId",
        before: { isFound: true, value: "rec_alpha" },
        after: { isFound: false },
        isChanged: true,
      },
    ]);
    const missing = buildChangeRequestChanges({
      kind: ChangeRequestKindEnum.Delete,
      readbackOp: deleteReadback,
      args: { recordId: "rec_zulu" },
      before: { error: "not found" },
    });
    expect(countChangedFields(missing)).toBe(0);
  });
});

describe("buildChangeRequestSummary", () => {
  it("names the tool and the shape of the change, never a value", () => {
    expect(buildChangeRequestSummary("update_record", ChangeRequestKindEnum.Update, 2)).toBe(
      "update_record: 2 fields changed",
    );
    expect(buildChangeRequestSummary("create_record", ChangeRequestKindEnum.Create, 1)).toBe(
      "create_record: new record, 1 field",
    );
    expect(buildChangeRequestSummary("delete_record", ChangeRequestKindEnum.Delete, 1)).toBe(
      "delete_record: delete record",
    );
  });
});
