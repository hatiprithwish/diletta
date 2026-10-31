import { describe, it, expect } from "vitest";
import {
  EVAL_CASE_TAG_PLACEHOLDER,
  ZEvalCaseInputV1,
  ZEvalCaseName,
  toEvalCase,
} from "../evalCases/EvalCasesCommon";
import { TEST_HOST_SEED_RECORDS } from "./TestHostCommon";
import { TEST_HOST_EVAL_CASES } from "./TestHostEvalCases";
import { TEST_HOST_TOOL_DEFINITIONS } from "./TestHostTools";

const toolNamed = (name: string) => TEST_HOST_TOOL_DEFINITIONS.find((tool) => tool.name === name);

describe("TEST_HOST_EVAL_CASES", () => {
  it("are cases the seed can store, one per name", () => {
    const names = TEST_HOST_EVAL_CASES.map((evalCase) => evalCase.name);
    expect(new Set(names).size).toBe(names.length);
    for (const evalCase of TEST_HOST_EVAL_CASES) {
      expect(ZEvalCaseName.safeParse(evalCase.name).success).toBe(true);
      const written = toEvalCase(evalCase.body);
      expect(written.isSuccess).toBe(true);
      if (written.isSuccess) expect(ZEvalCaseInputV1.safeParse(written.input).success).toBe(true);
    }
  });

  it("name only the test host's tools, and read back only fields their readback compares", () => {
    for (const { body } of TEST_HOST_EVAL_CASES) {
      const { toolCalls, forbiddenTools, readbacks } = body.checks;
      for (const name of [...toolCalls.map((call) => call.toolName), ...forbiddenTools]) {
        expect(toolNamed(name), name).toBeDefined();
      }
      for (const readback of readbacks) {
        const compare = toolNamed(readback.toolName)?.ops.readbackOp?.compare ?? {};
        expect(Object.keys(readback.expect).every((key) => key in compare)).toBe(true);
      }
    }
  });

  it("tag every record they create, and change only seed records otherwise", () => {
    const seedIds = new Set(TEST_HOST_SEED_RECORDS.map((record) => record.id));
    for (const { body } of TEST_HOST_EVAL_CASES) {
      for (const call of body.checks.toolCalls) {
        if (call.toolName === "create_record") {
          expect(String(call.args.name)).toContain(EVAL_CASE_TAG_PLACEHOLDER);
        } else if ("recordId" in call.args) {
          expect(seedIds.has(String(call.args.recordId))).toBe(true);
        }
      }
    }
  });
});
