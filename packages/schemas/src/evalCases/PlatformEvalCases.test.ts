import { describe, it, expect } from "vitest";
import { EVAL_CASE_NO_CHECKS, EvalCaseMessageRoleEnum } from "./EvalCasesCommon";
import {
  PLATFORM_EVAL_CASES,
  loadPlatformEvalCases,
  type PlatformEvalCaseDefinition,
} from "./PlatformEvalCases";

function definition(
  overrides: Partial<PlatformEvalCaseDefinition> = {},
): PlatformEvalCaseDefinition {
  return {
    platformKey: "core.example",
    name: "An example",
    isSafety: false,
    body: {
      messages: [{ role: EvalCaseMessageRoleEnum.User, text: "Hello?" }],
      rubric: "Greets the user.",
      checks: EVAL_CASE_NO_CHECKS,
    },
    ...overrides,
  };
}

describe("PLATFORM_EVAL_CASES", () => {
  it("loads: every case is stored as the current shapes", () => {
    const loaded = loadPlatformEvalCases();
    expect(loaded.isSuccess).toBe(true);
    if (!loaded.isSuccess) return;
    expect(loaded.cases).toHaveLength(PLATFORM_EVAL_CASES.length);
    expect(loaded.cases.some((evalCase) => evalCase.isSafety)).toBe(true);
  });

  it("names no tool: every company's gate runs them", () => {
    for (const evalCase of PLATFORM_EVAL_CASES) {
      expect(evalCase.body.checks.toolCalls).toEqual([]);
      expect(evalCase.body.checks.forbiddenTools).toEqual([]);
      expect(evalCase.body.checks.readbacks).toEqual([]);
    }
  });
});

describe("loadPlatformEvalCases", () => {
  it("refuses a key used twice", () => {
    const loaded = loadPlatformEvalCases([definition(), definition({ name: "Another" })]);
    expect(loaded).toEqual({
      isSuccess: false,
      message: "Platform case key core.example is used twice",
    });
  });

  it.each(["", "Core.Example", "core..example", "core example", "a".repeat(65)])(
    "refuses the key %j",
    (platformKey) => {
      expect(loadPlatformEvalCases([definition({ platformKey })]).isSuccess).toBe(false);
    },
  );

  it("refuses an empty name", () => {
    expect(loadPlatformEvalCases([definition({ name: "  " })]).isSuccess).toBe(false);
  });

  it("refuses a case that checks nothing, naming it", () => {
    const loaded = loadPlatformEvalCases([
      definition({ body: { ...definition().body, rubric: null } }),
    ]);
    expect(loaded).toEqual({
      isSuccess: false,
      message: "Platform case core.example: The case checks nothing",
    });
  });

  it("refuses the whole list when one case is bad", () => {
    const loaded = loadPlatformEvalCases([
      definition(),
      definition({ platformKey: "core.bad", body: { ...definition().body, messages: [] } }),
    ]);
    expect(loaded.isSuccess).toBe(false);
  });

  it("stores input v1 and expectations at the current version", () => {
    const loaded = loadPlatformEvalCases([definition()]);
    expect(loaded.isSuccess && loaded.cases[0]).toMatchObject({
      platformKey: "core.example",
      name: "An example",
      isSafety: false,
      input: { schemaVersion: 1, messages: [{ role: "user", text: "Hello?" }] },
      expectations: { schemaVersion: 2, rubric: "Greets the user." },
    });
  });
});
