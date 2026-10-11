import { describe, it, expect } from "vitest";
import {
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
  ZToolDefinitionBase,
  getToolRiskOpsIssue,
} from "../toolDefinitions/ToolDefinitionsCommon";
import { normalizeToolOps } from "../toolDefinitions/ToolOpsLoader";
import { renderToolOp } from "../toolDefinitions/ToolOpRenderer";
import {
  TEST_HOST_AMOUNT_LIMIT,
  TEST_HOST_NAME_PATTERN,
  TEST_HOST_SEED_RECORDS,
  TestHostFaultKindEnum,
  ZTestHostFault,
  ZTestHostRecord,
  ZTestHostTokenRequest,
  ZTestHostUpdateRecordRequest,
  getTestHostBaseUrl,
} from "./TestHostCommon";
import { TEST_HOST_TOOL_DEFINITIONS } from "./TestHostTools";

const byName = (name: string) => {
  const tool = TEST_HOST_TOOL_DEFINITIONS.find((definition) => definition.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
};

describe("TEST_HOST_TOOL_DEFINITIONS", () => {
  it("are valid tool definitions a tool definition save would accept", () => {
    const names = TEST_HOST_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of TEST_HOST_TOOL_DEFINITIONS) {
      expect(ZToolDefinitionBase.safeParse({ ...tool, connectionPublicId: "conn_1" }).success).toBe(
        true,
      );
      expect(normalizeToolOps(tool.ops).isSuccess).toBe(true);
      expect(getToolRiskOpsIssue(tool.risk, tool.idempotencyMode, tool.ops)).toBeNull();
    }
  });

  it("cover a read, an Emulated write, a Native write and a destructive tool", () => {
    expect(byName("get_record").risk).toBe(ToolDefinitionRiskIntEnum.Read);
    expect(byName("update_record").idempotencyMode).toBe(
      ToolDefinitionIdempotencyModeIntEnum.Emulated,
    );
    expect(byName("create_record").idempotencyMode).toBe(
      ToolDefinitionIdempotencyModeIntEnum.Native,
    );
    expect(byName("delete_record").risk).toBe(ToolDefinitionRiskIntEnum.Destructive);
  });

  it("render only the fields the model passed", () => {
    const update = byName("update_record");
    expect(
      renderToolOp(update.ops.callOp, { args: { recordId: "rec_alpha", amount: 12.5 } }),
    ).toEqual({
      isSuccess: true,
      request: {
        method: "PATCH",
        path: "/records/rec_alpha",
        query: {},
        body: { amount: 12.5 },
      },
    });
    expect(renderToolOp(byName("list_records").ops.callOp, { args: {} }).request?.query).toEqual(
      {},
    );
  });

  it("undo a delete by putting the read-before record back", () => {
    const remove = byName("delete_record");
    const before = { data: TEST_HOST_SEED_RECORDS[0] };
    const undo = renderToolOp(remove.ops.inverseOp!, { args: { recordId: "rec_alpha" }, before });
    expect(undo.request).toMatchObject({
      method: "PUT",
      path: "/records/rec_alpha",
      body: {
        name: "Alpha Facilities",
        email: "ops@alpha.example",
        amount: 120,
        status: "active",
      },
    });
  });
});

describe("input_schema matches what the test host accepts", () => {
  it("states the record id pattern and the amount and name bounds the host enforces", () => {
    const properties = byName("update_record").ops.inputSchema.properties;
    expect(properties.recordId?.pattern).toBe(TEST_HOST_NAME_PATTERN.source);
    expect(properties.amount).toMatchObject({
      minimum: -TEST_HOST_AMOUNT_LIMIT,
      maximum: TEST_HOST_AMOUNT_LIMIT,
    });
    expect(properties.name).toMatchObject({ minLength: 1, maxLength: 200 });
    const blank = new RegExp(String(properties.name?.pattern));
    expect(blank.test("   ")).toBe(false);
    expect(blank.test(" Alpha ")).toBe(true);

    expect(ZTestHostUpdateRecordRequest.safeParse({ amount: TEST_HOST_AMOUNT_LIMIT }).success).toBe(
      true,
    );
    expect(
      ZTestHostUpdateRecordRequest.safeParse({ amount: TEST_HOST_AMOUNT_LIMIT + 1 }).success,
    ).toBe(false);
    expect(ZTestHostUpdateRecordRequest.safeParse({ name: "   " }).success).toBe(false);
  });
});

describe("test host shapes", () => {
  it("seed records are valid and uniquely named", () => {
    for (const record of TEST_HOST_SEED_RECORDS) {
      expect(ZTestHostRecord.safeParse(record).success).toBe(true);
    }
    expect(new Set(TEST_HOST_SEED_RECORDS.map((record) => record.id)).size).toBe(
      TEST_HOST_SEED_RECORDS.length,
    );
  });

  it("refuse an empty update, a zero lifetime and an unknown fault", () => {
    expect(ZTestHostUpdateRecordRequest.safeParse({}).success).toBe(false);
    expect(
      ZTestHostTokenRequest.safeParse({ workspace: "w1", sub: "u1", expiresInSeconds: 0 }).success,
    ).toBe(false);
    expect(ZTestHostTokenRequest.safeParse({ workspace: "w 1", sub: "u1" }).success).toBe(false);
    expect(ZTestHostFault.safeParse({ kind: "explode" }).success).toBe(false);
    expect(
      ZTestHostFault.safeParse({ kind: TestHostFaultKindEnum.Overwrite, fields: {} }).success,
    ).toBe(false);
    expect(
      ZTestHostFault.safeParse({
        kind: TestHostFaultKindEnum.Status,
        status: 503,
        isApplied: true,
        method: "PATCH",
      }).success,
    ).toBe(true);
  });

  it("builds a base_url under /v1/", () => {
    expect(getTestHostBaseUrl("https://host.example/")).toBe("https://host.example/v1/");
  });
});
