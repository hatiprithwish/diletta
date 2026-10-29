import { describe, it, expect } from "vitest";
import {
  EVAL_CASE_EXPECTATIONS_MAX_CHARS,
  EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
  EVAL_CASE_NO_CHECKS,
  EVAL_CASE_TAG_PLACEHOLDER,
  EvalCaseMessageRoleEnum,
  EvalCaseRuleKindEnum,
  ZEvalCaseExpectationsV2,
  loadEvalCaseExpectations,
  readEvalCaseBody,
  toEvalCase,
  type EvalCaseBody,
  type EvalCaseExpectationsV2,
} from "./EvalCasesCommon";

const messages = [{ role: EvalCaseMessageRoleEnum.User, text: "How often are fire drills?" }];

function fullExpectations(): EvalCaseExpectationsV2 {
  return {
    schemaVersion: EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
    rubric: null,
    rules: [{ kind: EvalCaseRuleKindEnum.Contains, text: `Drill ${EVAL_CASE_TAG_PLACEHOLDER}` }],
    toolCalls: [
      {
        toolName: "create_record",
        args: { name: `Drill ${EVAL_CASE_TAG_PLACEHOLDER}`, amount: 120 },
      },
      { toolName: "list_records", args: {} },
    ],
    forbiddenTools: ["delete_record"],
    readbacks: [{ toolName: "create_record", expect: { amount: 120 } }],
  };
}

function issueMessages(body: unknown): string[] {
  const result = ZEvalCaseExpectationsV2.safeParse(body);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("ZEvalCaseExpectationsV2", () => {
  it("keeps a case with every check as given", () => {
    expect(ZEvalCaseExpectationsV2.parse(fullExpectations())).toEqual(fullExpectations());
  });

  it("accepts a rubric alone, or one deterministic check alone", () => {
    expect(
      issueMessages({ ...fullExpectations(), ...EVAL_CASE_NO_CHECKS, rubric: "Says quarterly." }),
    ).toEqual([]);
    expect(
      issueMessages({
        ...fullExpectations(),
        ...EVAL_CASE_NO_CHECKS,
        forbiddenTools: ["delete_record"],
      }),
    ).toEqual([]);
  });

  it("refuses a case that checks nothing", () => {
    expect(issueMessages({ ...fullExpectations(), ...EVAL_CASE_NO_CHECKS })).toEqual([
      "The case checks nothing",
    ]);
  });

  it("refuses a forbidden tool listed twice or also expected", () => {
    expect(
      issueMessages({ ...fullExpectations(), forbiddenTools: ["delete_record", "delete_record"] }),
    ).toEqual(["A tool is listed twice"]);
    expect(issueMessages({ ...fullExpectations(), forbiddenTools: ["list_records"] })).toEqual([
      "A forbidden tool is also an expected call",
    ]);
  });

  it("refuses a readback of a tool not expected exactly once, or read back twice", () => {
    const base = fullExpectations();
    expect(
      issueMessages({ ...base, readbacks: [{ toolName: "update_record", expect: { amount: 1 } }] }),
    ).toEqual(["A readback names a tool expected exactly once in toolCalls"]);
    expect(issueMessages({ ...base, toolCalls: [...base.toolCalls, base.toolCalls[0]] })).toEqual([
      "A readback names a tool expected exactly once in toolCalls",
    ]);
    expect(issueMessages({ ...base, readbacks: [...base.readbacks, ...base.readbacks] })).toContain(
      "A tool is read back twice",
    );
  });

  it("refuses a readback that expects nothing, and a reserved or invalid tool name", () => {
    const base = fullExpectations();
    expect(
      issueMessages({ ...base, readbacks: [{ toolName: "create_record", expect: {} }] }),
    ).toEqual(["Expect at least one value"]);
    expect(issueMessages({ ...base, forbiddenTools: ["search_help_docs"] })).toEqual([
      "Reserved tool name",
    ]);
    expect(issueMessages({ ...base, forbiddenTools: ["9tool"] })).toEqual(["Invalid tool name"]);
  });

  it("refuses expectations longer than EVAL_CASE_EXPECTATIONS_MAX_CHARS", () => {
    const longText = "x".repeat(450);
    const toolCalls = Array.from({ length: 10 }, (_, index) => ({
      toolName: `tool_${index}`,
      args: Object.fromEntries(Array.from({ length: 5 }, (_, key) => [`arg${key}`, longText])),
    }));
    expect(JSON.stringify({ ...fullExpectations(), toolCalls }).length).toBeGreaterThan(
      EVAL_CASE_EXPECTATIONS_MAX_CHARS,
    );
    expect(issueMessages({ ...fullExpectations(), toolCalls, readbacks: [] })).toEqual([
      "The expectations are too long",
    ]);
  });
});

describe("loadEvalCaseExpectations", () => {
  it("upgrades a v1 body to a rubric-only v2 body without touching the stored one", () => {
    const stored = { schemaVersion: 1, rubric: "Says quarterly." };
    expect(loadEvalCaseExpectations(stored)).toEqual({
      schemaVersion: EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
      rubric: "Says quarterly.",
      ...EVAL_CASE_NO_CHECKS,
    });
    expect(stored).toEqual({ schemaVersion: 1, rubric: "Says quarterly." });
  });

  it("reads a current body as is", () => {
    expect(loadEvalCaseExpectations(fullExpectations())).toEqual(fullExpectations());
  });

  it("is null for an unknown version, a body its own version refuses, or no body", () => {
    expect(loadEvalCaseExpectations({ ...fullExpectations(), schemaVersion: 3 })).toBeNull();
    expect(loadEvalCaseExpectations({ schemaVersion: 1, rubric: "" })).toBeNull();
    expect(loadEvalCaseExpectations({ schemaVersion: 1 })).toBeNull();
    expect(loadEvalCaseExpectations({ ...fullExpectations(), ...EVAL_CASE_NO_CHECKS })).toBeNull();
    expect(loadEvalCaseExpectations(null)).toBeNull();
    expect(loadEvalCaseExpectations({})).toBeNull();
  });
});

describe("readEvalCaseBody / toEvalCase", () => {
  const body: EvalCaseBody = { messages, rubric: "Says quarterly.", checks: EVAL_CASE_NO_CHECKS };

  it("reads back what toEvalCase stores, at the current version", () => {
    const stored = toEvalCase(body);
    expect(stored?.expectations.schemaVersion).toBe(EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION);
    expect(readEvalCaseBody(stored?.input, stored?.expectations)).toEqual(body);
  });

  it("reads a stored v1 case, and keeps a v2 case's checks", () => {
    expect(
      readEvalCaseBody(
        { schemaVersion: 1, messages },
        { schemaVersion: 1, rubric: "Says quarterly." },
      ),
    ).toEqual(body);
    const { schemaVersion: _version, rubric: _rubric, ...checks } = fullExpectations();
    expect(readEvalCaseBody({ schemaVersion: 1, messages }, fullExpectations())).toEqual({
      messages,
      rubric: null,
      checks,
    });
  });

  it("is null for a shape it can't edit", () => {
    const stored = toEvalCase(body);
    expect(
      readEvalCaseBody({ ...stored?.input, schemaVersion: 2 }, stored?.expectations),
    ).toBeNull();
    expect(readEvalCaseBody(stored?.input, {})).toBeNull();
  });

  it("stores nothing for a body that checks nothing", () => {
    expect(toEvalCase({ ...body, rubric: null })).toBeNull();
  });
});
