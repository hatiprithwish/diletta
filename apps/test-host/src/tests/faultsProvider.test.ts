import { describe, it, expect } from "vitest";
import TestHostFaultsProvider from "@/providers/faults";
import * as Schemas from "@app/schemas";

const { Get, Patch, Post } = Schemas.ToolOpMethodEnum;
const status = (
  match: { method?: Schemas.ToolOpMethodEnum; path?: string } = {},
): Schemas.TestHostFault => ({
  kind: Schemas.TestHostFaultKindEnum.Status,
  status: 503,
  isApplied: false,
  ...match,
});

const record: Schemas.TestHostRecord = {
  id: "rec_new",
  name: "New",
  email: "n@x.co",
  amount: 1,
  status: Schemas.TestHostRecordStatusEnum.Active,
};
const run = (
  code: number,
  body: object | null = null,
  isReplay = false,
): Schemas.TestHostRunResult => ({
  response: { status: code, body: body === null ? null : JSON.stringify(body) },
  isReplay,
});
const update: Schemas.TestHostOperation = {
  kind: Schemas.TestHostOperationKindEnum.Update,
  id: "rec_alpha",
  fields: { amount: 1 },
};

describe("TestHostFaultsProvider.take", () => {
  it("takes the first fault matching method and path, leaving the rest in order", () => {
    const faults = [
      status({ method: Post }),
      status({ path: "/v1/records/rec_bravo" }),
      status({ method: Patch, path: "/v1/records/rec_alpha" }),
      status(),
    ];
    const taken = TestHostFaultsProvider.take(faults, Patch, "/v1/records/rec_alpha");
    expect(taken.fault).toBe(faults[2]);
    expect(taken.remaining).toEqual([faults[0], faults[1], faults[3]]);
    expect(faults).toHaveLength(4);
  });

  it("takes nothing when no fault matches", () => {
    const faults = [status({ method: Post })];
    expect(TestHostFaultsProvider.take(faults, Get, "/v1/records")).toEqual({
      fault: null,
      remaining: faults,
    });
  });
});

describe("TestHostFaultsProvider.getOverwriteTarget", () => {
  it("targets the record a successful write touched", () => {
    expect(TestHostFaultsProvider.getOverwriteTarget(update, run(200, { data: record }))).toBe(
      "rec_alpha",
    );
    expect(
      TestHostFaultsProvider.getOverwriteTarget(
        { kind: Schemas.TestHostOperationKindEnum.Put, id: "rec_x", record },
        run(201, { data: record }),
      ),
    ).toBe("rec_x");
    expect(
      TestHostFaultsProvider.getOverwriteTarget(
        { kind: Schemas.TestHostOperationKindEnum.Create, record },
        run(201, { data: record }),
      ),
    ).toBe("rec_new");
  });

  it("targets nothing after a refused or replayed write, a read, a delete or a reset", () => {
    expect(TestHostFaultsProvider.getOverwriteTarget(update, run(422, { error: "x" }))).toBeNull();
    expect(TestHostFaultsProvider.getOverwriteTarget(update, run(404, { error: "x" }))).toBeNull();
    expect(
      TestHostFaultsProvider.getOverwriteTarget(update, run(200, { data: record }, true)),
    ).toBeNull();
    expect(
      TestHostFaultsProvider.getOverwriteTarget(
        { kind: Schemas.TestHostOperationKindEnum.Get, id: "rec_alpha" },
        run(200, { data: record }),
      ),
    ).toBeNull();
    expect(
      TestHostFaultsProvider.getOverwriteTarget(
        { kind: Schemas.TestHostOperationKindEnum.Delete, id: "rec_alpha" },
        run(204),
      ),
    ).toBeNull();
    expect(
      TestHostFaultsProvider.getOverwriteTarget(
        { kind: Schemas.TestHostOperationKindEnum.Reset },
        run(200, { data: [] }),
      ),
    ).toBeNull();
  });
});
