import { describe, expect, it } from "vitest";
import { HOST_ISSUES_MAX, HOST_ISSUE_TEXT_MAX_CHARS, extractHostIssues } from "./HostIssues";

// DEV_NOTE: eRegister's answer for an action whose first step has no dependencies, as the host sent it (ADR 0008)
const EREGISTER_ANSWER = {
  isSuccess: false,
  message: "Invalid request data. Please verify and try again.",
  zodErrors: [
    {
      code: "invalid_union",
      errors: [
        [
          {
            expected: "array",
            code: "invalid_type",
            path: ["steps", "step_1", "dependencies"],
            message: "Invalid input: expected array, received undefined",
          },
        ],
        [
          {
            expected: "string",
            code: "invalid_type",
            path: [],
            message: "Invalid input: expected string, received object",
          },
        ],
      ],
      path: ["flowSchema"],
      message: "Invalid input",
    },
  ],
};

describe("extractHostIssues", () => {
  it("reads a union's nested issues as full paths, outer issue first", () => {
    expect(extractHostIssues(400, EREGISTER_ANSWER)).toEqual([
      { path: "flowSchema", message: "Invalid input" },
      {
        path: "flowSchema.steps.step_1.dependencies",
        message: "Invalid input: expected array, received undefined",
      },
      { path: "flowSchema", message: "Invalid input: expected string, received object" },
    ]);
  });

  it("keeps only a path and a message: no other key or value of the answer", () => {
    const issues = extractHostIssues(422, {
      detail: "jane@acme.com is taken",
      errors: [{ path: ["email"], message: "Already used", input: "jane@acme.com", code: "dup" }],
    });
    expect(issues).toEqual([{ path: "email", message: "Already used" }]);
    expect(JSON.stringify(issues)).not.toContain("jane@acme.com");
  });

  it("answers nothing for any other status, and for an answer with no issue in it", () => {
    for (const status of [undefined, 401, 403, 404, 409, 500]) {
      expect(extractHostIssues(status, EREGISTER_ANSWER)).toEqual([]);
    }
    expect(extractHostIssues(400, { error: "Bad request" })).toEqual([]);
    expect(extractHostIssues(400, "plain text")).toEqual([]);
    expect(extractHostIssues(400, null)).toEqual([]);
    expect(
      extractHostIssues(400, [
        { path: [{}], message: "x" },
        { path: ["a"], message: "" },
      ]),
    ).toEqual([]);
  });

  it("takes a string path, numbers in a path, and names a whole-body issue", () => {
    expect(
      extractHostIssues(400, {
        issues: [
          { path: "body.name", message: "Required" },
          { path: ["items", 2, "qty"], message: "Too small" },
          { path: [], message: "Body is empty" },
        ],
      }),
    ).toEqual([
      { path: "body.name", message: "Required" },
      { path: "items.2.qty", message: "Too small" },
      { path: "(body)", message: "Body is empty" },
    ]);
  });

  it("drops repeats, caps the count and the length, and collapses whitespace", () => {
    const repeated = extractHostIssues(400, [
      { path: ["a"], message: "Bad" },
      { path: ["a"], message: "Bad" },
    ]);
    expect(repeated).toHaveLength(1);

    const many = extractHostIssues(
      400,
      Array.from({ length: HOST_ISSUES_MAX + 5 }, (_, index) => ({
        path: [`f${index}`],
        message: `Bad ${index}`,
      })),
    );
    expect(many).toHaveLength(HOST_ISSUES_MAX);

    const [long] = extractHostIssues(400, [
      { path: ["x".repeat(500)], message: `a\n\n  b ${"y".repeat(500)}` },
    ]);
    expect(long?.path).toBe(`${"x".repeat(HOST_ISSUE_TEXT_MAX_CHARS)}…`);
    expect(long?.message.startsWith("a b y")).toBe(true);
    expect(long?.message).toHaveLength(HOST_ISSUE_TEXT_MAX_CHARS + 1);
  });

  it("stops at a depth bound, so a hostile answer costs little", () => {
    let deep: unknown = { path: ["leaf"], message: "Deep" };
    for (let index = 0; index < 50; index++) deep = { nested: deep };
    expect(extractHostIssues(400, deep)).toEqual([]);
  });
});
