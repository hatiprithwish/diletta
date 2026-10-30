import { describe, it, expect } from "vitest";
import { ZConnectionResetOp } from "../companyConnections";
import { EVAL_GRADER_OUTPUT_SCHEMA_VERSION, EvalCheckKindEnum } from "../evalResults";
import { HostCallOutcomeEnum } from "../hostAdapter";
import { ToolOpMethodEnum } from "../toolDefinitions";
import { TEST_HOST_RESET_OP } from "../testHost";
import { ModelProviderEnum } from "../companySecrets";
import { EvalRunFailureIntEnum } from "../evalRuns";
import { getModelPrice } from "../modelRouter";
import { HostToolStatusEnum } from "../toolCalls";
import { ZFinishEvalRunApiRequest, ZRecordEvalResultApiRequest } from "./EvalHarnessApiRequest";
import {
  EVAL_JUDGE_MODELS,
  EVAL_TRANSCRIPT_TOOL_STATUS_MAP,
  EvalReadbackVerdictEnum,
  ZEvalJudgeOutput,
  ZEvalJwtClaims,
  checkEvalReadback,
} from "./EvalHarnessCommon";

const readbackOp = {
  method: ToolOpMethodEnum.Get as const,
  path: "/records/{args.recordId}",
  compare: { amount: "data.amount", status: "data.status" },
};
const answered = (body: unknown) => ({
  outcome: HostCallOutcomeEnum.Succeeded,
  httpStatus: 200,
  body,
});

describe("checkEvalReadback", () => {
  it("matches when every expect key reads back JSON-equal at its compare path", () => {
    const check = checkEvalReadback({
      readbackOp,
      expect: { amount: 300, status: "closed" },
      readback: answered({ data: { amount: 300, status: "closed" } }),
    });
    expect(check.verdict).toBe(EvalReadbackVerdictEnum.Matches);
    expect(check.fields).toEqual([
      { name: "amount", isMatch: true, expected: 300, found: 300, isFound: true },
      { name: "status", isMatch: true, expected: "closed", found: "closed", isFound: true },
    ]);
  });

  it("differs on another value, another JSON type or a missing field", () => {
    const typed = checkEvalReadback({
      readbackOp,
      expect: { amount: 300 },
      readback: answered({ data: { amount: "300" } }),
    });
    expect(typed.verdict).toBe(EvalReadbackVerdictEnum.Differs);
    const missing = checkEvalReadback({
      readbackOp,
      expect: { status: "closed" },
      readback: answered({ data: {} }),
    });
    expect(missing.verdict).toBe(EvalReadbackVerdictEnum.Differs);
    expect(missing.fields[0]).toMatchObject({ isMatch: false, found: null, isFound: false });
  });

  it("is unknown, never a pass, when the read failed or a key isn't a compare key", () => {
    expect(
      checkEvalReadback({
        readbackOp,
        expect: { amount: 300 },
        readback: { outcome: HostCallOutcomeEnum.Refused, httpStatus: 404 },
      }),
    ).toMatchObject({
      verdict: EvalReadbackVerdictEnum.Unknown,
      reason: expect.stringContaining("404"),
    });
    expect(
      checkEvalReadback({
        readbackOp,
        expect: { email: "a@b.example" },
        readback: answered({ data: { email: "a@b.example" } }),
      }),
    ).toMatchObject({
      verdict: EvalReadbackVerdictEnum.Unknown,
      reason: "Not a compare field of the tool: email",
    });
  });
});

describe("ZConnectionResetOp", () => {
  it("is a call op with no placeholders", () => {
    expect(ZConnectionResetOp.safeParse(TEST_HOST_RESET_OP).success).toBe(true);
    expect(
      ZConnectionResetOp.safeParse({ method: ToolOpMethodEnum.Post, path: "/reset/{args.id}" })
        .success,
    ).toBe(false);
    expect(
      ZConnectionResetOp.safeParse({
        method: ToolOpMethodEnum.Post,
        path: "/reset",
        bodyMap: { scope: "{before.scope}" },
      }).success,
    ).toBe(false);
    expect(
      ZConnectionResetOp.safeParse({ method: ToolOpMethodEnum.Post, path: "reset" }).success,
    ).toBe(false);
  });
});

describe("eval API requests", () => {
  it("refuses a passing attempt whose grading stopped", () => {
    const body = {
      caseId: "case_1",
      attempt: 1,
      hasPassed: true,
      graderOutput: {
        schemaVersion: EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
        checks: [
          { kind: EvalCheckKindEnum.Rubric, hasPassed: true, label: "Says 300", detail: null },
        ],
        error: null,
      },
      latencyMs: 10,
    };
    expect(ZRecordEvalResultApiRequest.safeParse(body).success).toBe(true);
    expect(
      ZRecordEvalResultApiRequest.safeParse({
        ...body,
        graderOutput: { ...body.graderOutput, error: "Judge unreachable" },
      }).success,
    ).toBe(false);
  });

  it("takes eval tokens from the harness only, naming a company and a connection", () => {
    const claims = {
      iss: "diletta-eval-harness",
      sub: "eval-user",
      aud: "diletta-eval",
      iat: 1,
      exp: 2,
      company: "co_1",
      connection: "cn_1",
    };
    expect(ZEvalJwtClaims.safeParse(claims).success).toBe(true);
    expect(ZEvalJwtClaims.safeParse({ ...claims, iss: "https://host.example" }).success).toBe(
      false,
    );
    expect(ZEvalJwtClaims.safeParse({ ...claims, connection: undefined }).success).toBe(false);
  });
});

describe("the pinned judge (M5-3)", () => {
  it("pins a priced model for every provider, so every judge call can be costed", () => {
    for (const provider of Object.values(ModelProviderEnum)) {
      expect(getModelPrice(provider, EVAL_JUDGE_MODELS[provider])).not.toBeNull();
    }
  });

  it("holds the judge's answer to a verdict and a reason", () => {
    expect(
      ZEvalJudgeOutput.safeParse({ hasPassed: true, reason: "Explains the refund rule." }).success,
    ).toBe(true);
    expect(ZEvalJudgeOutput.safeParse({ hasPassed: true, reason: "  " }).success).toBe(false);
    expect(ZEvalJudgeOutput.safeParse({ reason: "No verdict" }).success).toBe(false);
  });

  it("maps every way a tool call ends to a transcript status", () => {
    for (const status of Object.values(HostToolStatusEnum)) {
      expect(EVAL_TRANSCRIPT_TOOL_STATUS_MAP[status].text.length).toBeGreaterThan(0);
    }
  });
});

describe("finishing a run with a failure (M5-3)", () => {
  it("takes a failure only on a run that didn't complete", () => {
    expect(
      ZFinishEvalRunApiRequest.safeParse({
        isComplete: false,
        failure: EvalRunFailureIntEnum.JudgeUnavailable,
      }).success,
    ).toBe(true);
    expect(ZFinishEvalRunApiRequest.safeParse({ isComplete: true }).success).toBe(true);
    expect(ZFinishEvalRunApiRequest.safeParse({ isComplete: true, failure: null }).success).toBe(
      true,
    );
    expect(
      ZFinishEvalRunApiRequest.safeParse({
        isComplete: true,
        failure: EvalRunFailureIntEnum.ServerError,
      }).success,
    ).toBe(false);
  });
});
