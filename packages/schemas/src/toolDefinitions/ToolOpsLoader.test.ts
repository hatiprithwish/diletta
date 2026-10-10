import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CURRENT_TOOL_OPS_SCHEMA_VERSION,
  defineToolOpsUpgrader,
  type ToolOpsRegistry,
} from "./ToolOpsRegistry";
import { loadToolOps, normalizeToolOps, upgradeToolOps } from "./ToolOpsLoader";
import { ToolOpMethodEnum, ZToolOpsV1, type ToolOpsV1Input } from "./ToolOpsV1";
import {
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
  getToolRiskOpsIssue,
} from "./ToolDefinitionsCommon";

function validOps(): ToolOpsV1Input {
  return {
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string" }, amount: { type: "number" } },
      required: ["recordId"],
      additionalProperties: false,
    },
    callOp: {
      method: ToolOpMethodEnum.Patch,
      path: "/records/{args.recordId}",
      bodyMap: { amount: "{args.amount}" },
    },
    readbackOp: {
      method: ToolOpMethodEnum.Get,
      path: "/records/{args.recordId}",
      compare: { amount: "data.amount" },
    },
    inverseOp: {
      method: ToolOpMethodEnum.Patch,
      path: "/records/{args.recordId}",
      bodyMap: { amount: "{before.data.amount}" },
    },
  };
}

function messageOf(ops: unknown): string {
  const result = normalizeToolOps(ops);
  expect(result.isSuccess).toBe(false);
  return result.message ?? "";
}

describe("normalizeToolOps (write path)", () => {
  it("accepts valid ops at the current version and keeps unknown JSON Schema keywords", () => {
    const result = normalizeToolOps(validOps());
    expect(result.isSuccess).toBe(true);
    expect(result.schemaVersion).toBe(CURRENT_TOOL_OPS_SCHEMA_VERSION);
    expect(result.ops?.inputSchema).toHaveProperty("additionalProperties", false);
  });

  it("accepts a trailing slash and the root path", () => {
    for (const path of ["/records/", "/"]) {
      const ops = validOps();
      ops.callOp.path = path;
      expect(normalizeToolOps(ops).isSuccess).toBe(true);
    }
  });

  it("accepts a read tool: no readback, no inverse", () => {
    const result = normalizeToolOps({
      ...validOps(),
      callOp: {
        method: ToolOpMethodEnum.Get,
        path: "/records",
        query: { amount: "{args.amount}" },
      },
      readbackOp: null,
      inverseOp: null,
    });
    expect(result.isSuccess).toBe(true);
  });

  it("refuses an arg that isn't an input_schema property", () => {
    const ops = validOps();
    ops.callOp.path = "/records/{args.recordID}";
    expect(messageOf(ops)).toContain('"recordID" is not an input_schema property');
  });

  it("refuses a compare key that isn't an arg", () => {
    const ops = validOps();
    ops.readbackOp = { ...ops.readbackOp!, compare: { total: "data.total" } };
    expect(messageOf(ops)).toContain('compare key "total" is not an input_schema property');
  });

  it("refuses before / result in call_op and before in readback_op", () => {
    const callOps = validOps();
    callOps.callOp.bodyMap = { amount: "{before.data.amount}" };
    expect(messageOf(callOps)).toContain("callOp can't read before");

    const resultOps = validOps();
    resultOps.callOp.path = "/records/{result.id}";
    expect(messageOf(resultOps)).toContain("callOp can't read result");

    const readbackOps = validOps();
    readbackOps.readbackOp = { ...readbackOps.readbackOp!, path: "/records/{before.id}" };
    expect(messageOf(readbackOps)).toContain("readbackOp can't read before");
  });

  it("lets readback_op read result and inverse_op read before and result", () => {
    const ops = validOps();
    ops.readbackOp = { ...ops.readbackOp!, path: "/records/{result.id}" };
    ops.inverseOp = {
      method: ToolOpMethodEnum.Delete,
      path: "/records/{result.id}/v/{before.data.version}",
    };
    expect(normalizeToolOps(ops).isSuccess).toBe(true);
  });

  it("refuses an unknown placeholder root (a typo)", () => {
    const ops = validOps();
    ops.callOp.bodyMap = { amount: "{arg.amount}" };
    expect(messageOf(ops)).toContain("Unknown placeholder {arg.amount}");
  });

  it("refuses a malformed placeholder with a known root", () => {
    for (const token of [
      "{args.items[0]}",
      "{args.recordId }",
      "{args.}",
      "{args}",
      "{ result.id}",
    ]) {
      const ops = validOps();
      ops.inverseOp = { ...ops.inverseOp!, bodyMap: { x: `v=${token}` } };
      expect(messageOf(ops)).toContain(`Malformed placeholder ${token}`);
    }
  });

  it("refuses unsafe paths, a non-GET readback and an empty compare", () => {
    for (const path of [
      "/records//x",
      "//",
      "records",
      "//evil.example/x",
      "https://evil.example",
      "/a/../b",
      "/a?b=1",
    ]) {
      const ops = validOps();
      ops.callOp.path = path;
      expect(normalizeToolOps(ops).isSuccess).toBe(false);
    }

    const postReadback = validOps();
    postReadback.readbackOp = {
      ...postReadback.readbackOp!,
      method: ToolOpMethodEnum.Post as ToolOpMethodEnum.Get,
    };
    expect(normalizeToolOps(postReadback).isSuccess).toBe(false);

    const emptyCompare = validOps();
    emptyCompare.readbackOp = { ...emptyCompare.readbackOp!, compare: {} };
    expect(messageOf(emptyCompare)).toContain("compare needs at least one field");
  });

  it("refuses a misspelt op key and a required name that isn't a property", () => {
    expect(normalizeToolOps({ ...validOps(), callOps: validOps().callOp }).isSuccess).toBe(false);

    const ops = validOps();
    ops.inputSchema = { ...ops.inputSchema, required: ["missing"] };
    expect(messageOf(ops)).toContain('Required "missing" is not a property');
  });
});

describe("getToolRiskOpsIssue", () => {
  const none = ToolDefinitionIdempotencyModeIntEnum.None;

  it("ties readback and inverse ops to the risk", () => {
    const ops = ZToolOpsV1.parse(validOps());
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Write, none, ops)).toBeNull();
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Destructive, none, ops)).toBeNull();
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Read, none, ops)).toBe(
      "A read tool has no readback op",
    );
    expect(
      getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Read, none, {
        readbackOp: null,
        inverseOp: null,
      }),
    ).toBeNull();
    expect(
      getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Read, none, {
        readbackOp: null,
        inverseOp: ops.inverseOp,
      }),
    ).toBe("A read tool has no inverse op");
    expect(
      getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Write, none, {
        readbackOp: null,
        inverseOp: null,
      }),
    ).toBe("A write tool needs a readback op");
  });

  it("keeps an emulated write's readback and inverse ops off {result.*}", () => {
    const emulated = ToolDefinitionIdempotencyModeIntEnum.Emulated;
    const ops = ZToolOpsV1.parse(validOps());
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Write, emulated, ops)).toBeNull();

    const readsResult = {
      ...ops,
      readbackOp: { ...ops.readbackOp!, path: "/records/{result.id}" },
    };
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Write, emulated, readsResult)).toBe(
      "An emulated-idempotency tool's readback op can't read {result.*}",
    );
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Write, none, readsResult)).toBeNull();
    expect(
      getToolRiskOpsIssue(
        ToolDefinitionRiskIntEnum.Write,
        ToolDefinitionIdempotencyModeIntEnum.Native,
        readsResult,
      ),
    ).toBeNull();

    const inverseReadsResult = {
      ...ops,
      inverseOp: { ...ops.inverseOp!, bodyMap: { nested: ["{result.data.amount}"] } },
    };
    expect(getToolRiskOpsIssue(ToolDefinitionRiskIntEnum.Write, emulated, inverseReadsResult)).toBe(
      "An emulated-idempotency tool's inverse op can't read {result.*}",
    );
  });

  it("ignores the idempotency mode of a read tool", () => {
    expect(
      getToolRiskOpsIssue(
        ToolDefinitionRiskIntEnum.Read,
        ToolDefinitionIdempotencyModeIntEnum.Emulated,
        { readbackOp: null, inverseOp: null },
      ),
    ).toBeNull();
  });
});

describe("loadToolOps (read path)", () => {
  it("loads stored ops at the current version", () => {
    const result = loadToolOps({ schemaVersion: CURRENT_TOOL_OPS_SCHEMA_VERSION, ops: validOps() });
    expect(result.isSuccess).toBe(true);
    expect(result.wasUpgraded).toBe(false);
  });

  it("refuses an unknown schema version and invalid stored ops", () => {
    expect(loadToolOps({ schemaVersion: 0, ops: validOps() }).isSuccess).toBe(false);
    expect(
      loadToolOps({ schemaVersion: CURRENT_TOOL_OPS_SCHEMA_VERSION + 1, ops: validOps() })
        .isSuccess,
    ).toBe(false);
    expect(loadToolOps({ schemaVersion: CURRENT_TOOL_OPS_SCHEMA_VERSION, ops: {} }).isSuccess).toBe(
      false,
    );
  });
});

describe("upgradeToolOps (version chain)", () => {
  // A fake v2 that renames bodyMap → body on call_op, to drive the chain
  const ZOpsV2 = z.strictObject({
    callOp: z.strictObject({ method: z.string(), path: z.string(), body: z.unknown() }),
  });
  const registry: ToolOpsRegistry<typeof ZOpsV2> = {
    currentVersion: 2,
    currentSchema: ZOpsV2,
    upgraders: {
      1: defineToolOpsUpgrader(ZToolOpsV1, (ops) => ({
        callOp: { method: ops.callOp.method, path: ops.callOp.path, body: ops.callOp.bodyMap },
      })),
    },
  };

  it("upgrades v1 ops to the current version", () => {
    const result = upgradeToolOps(registry, { schemaVersion: 1, ops: validOps() });
    expect(result).toEqual({
      isSuccess: true,
      wasUpgraded: true,
      ops: {
        callOp: {
          method: ToolOpMethodEnum.Patch,
          path: "/records/{args.recordId}",
          body: { amount: "{args.amount}" },
        },
      },
    });
  });

  it("refuses ops invalid at their own version, a missing upgrader and a throwing one", () => {
    expect(upgradeToolOps(registry, { schemaVersion: 1, ops: {} }).message).toContain(
      "Invalid tool ops at schema version 1",
    );
    expect(
      upgradeToolOps({ ...registry, upgraders: {} }, { schemaVersion: 1, ops: validOps() }).message,
    ).toBe("No upgrader registered from tool ops schema version 1");
    const throwing: ToolOpsRegistry<typeof ZOpsV2> = {
      ...registry,
      upgraders: {
        1: () => {
          throw new Error("boom");
        },
      },
    };
    expect(upgradeToolOps(throwing, { schemaVersion: 1, ops: validOps() }).message).toBe(
      "Tool ops upgrade from schema version 1 failed: boom",
    );
  });
});
