import { describe, it, expect } from "vitest";
import { EvalCaseMessageRoleEnum } from "../evalCases";
import { EvalRunStatusIntEnum, evalCaseRunResult } from "../evalRuns";
import { ToolCallStatusIntEnum } from "../toolCalls";
import {
  EVAL_TRANSCRIPT_MAX_BYTES,
  EvalCheckKindEnum,
  EvalTranscriptEntryKindEnum,
  parseEvalGraderOutput,
  parseEvalTranscript,
} from "./EvalResultsCommon";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const graderOutput = {
  schemaVersion: 1,
  checks: [
    {
      kind: EvalCheckKindEnum.ForbiddenTool,
      hasPassed: true,
      label: "Never called delete_record",
      detail: "Forbidden tool not used.",
    },
    {
      kind: EvalCheckKindEnum.Readback,
      hasPassed: false,
      label: "EXT-T-901 left unchanged",
      detail: "Read back in attempt 2: Open → Closed.",
    },
  ],
  error: null,
};

const transcript = {
  schemaVersion: 1,
  entries: [
    { kind: EvalTranscriptEntryKindEnum.Message, role: EvalCaseMessageRoleEnum.User, text: "Hi" },
    {
      kind: EvalTranscriptEntryKindEnum.ToolCall,
      toolName: "update_record",
      toolVersion: 2,
      status: ToolCallStatusIntEnum.Ok,
      summary: "Close EXT-T-901",
    },
    {
      kind: EvalTranscriptEntryKindEnum.Message,
      role: EvalCaseMessageRoleEnum.Assistant,
      text: "Done.",
    },
  ],
};

describe("parseEvalGraderOutput", () => {
  it("reads a v1 grader output", () => {
    expect(parseEvalGraderOutput(graderOutput)).toEqual(graderOutput);
  });

  it("keeps the error that stopped grading", () => {
    const stopped = { ...graderOutput, checks: [], error: "Judge unreachable" };
    expect(parseEvalGraderOutput(stopped)?.error).toBe("Judge unreachable");
  });

  it("is null for nothing, another version or an unknown check", () => {
    expect(parseEvalGraderOutput(null)).toBeNull();
    expect(parseEvalGraderOutput({ ...graderOutput, schemaVersion: 2 })).toBeNull();
    expect(
      parseEvalGraderOutput({
        ...graderOutput,
        checks: [{ ...graderOutput.checks[0], kind: "vibes" }],
      }),
    ).toBeNull();
  });
});

describe("parseEvalTranscript", () => {
  it("reads a v1 transcript file", () => {
    expect(parseEvalTranscript(encode(transcript))).toEqual(transcript);
  });

  it("is null for bytes that aren't UTF-8 JSON of a transcript", () => {
    expect(parseEvalTranscript(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(parseEvalTranscript(new TextEncoder().encode("{"))).toBeNull();
    expect(parseEvalTranscript(encode({ ...transcript, schemaVersion: 2 }))).toBeNull();
    expect(
      parseEvalTranscript(
        encode({ ...transcript, entries: [{ kind: EvalTranscriptEntryKindEnum.ToolCall }] }),
      ),
    ).toBeNull();
  });

  it("refuses a file over EVAL_TRANSCRIPT_MAX_BYTES without parsing it", () => {
    expect(parseEvalTranscript(new Uint8Array(EVAL_TRANSCRIPT_MAX_BYTES + 1))).toBeNull();
  });
});

describe("evalCaseRunResult", () => {
  const { Queued, Running, Done, Failed } = EvalRunStatusIntEnum;
  const result = (
    passedAttemptCount: number,
    attemptCount: number,
    runStatus: EvalRunStatusIntEnum,
  ) => evalCaseRunResult({ passedAttemptCount, attemptCount, k: 3, runStatus });

  it("passes only when every one of k attempts passed", () => {
    expect(result(3, 3, Done)).toBe(true);
    expect(result(3, 3, Running)).toBe(true);
    expect(
      evalCaseRunResult({ passedAttemptCount: 0, attemptCount: 0, k: 0, runStatus: Done }),
    ).toBe(false);
  });

  it("fails as soon as an attempt failed, even mid-run", () => {
    expect(result(2, 3, Done)).toBe(false);
    expect(result(0, 1, Running)).toBe(false);
  });

  it("is still running while the run is under way and nothing failed", () => {
    expect(result(1, 1, Running)).toBeNull();
    expect(result(0, 0, Queued)).toBeNull();
  });

  it("fails a case left short when the run ended", () => {
    expect(result(1, 1, Done)).toBe(false);
    expect(result(1, 1, Failed)).toBe(false);
  });
});
