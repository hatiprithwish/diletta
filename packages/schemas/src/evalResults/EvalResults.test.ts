import { describe, it, expect } from "vitest";
import {
  EvalCaseMessageRoleEnum,
  readEvalCaseBody,
  toEvalCaseV1,
  type EvalCaseBody,
} from "../evalCases";
import { hasEvalCasePassed } from "../evalRuns";
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

describe("readEvalCaseBody", () => {
  const body: EvalCaseBody = {
    messages: [{ role: EvalCaseMessageRoleEnum.User, text: "How often are fire drills?" }],
    rubric: "Says quarterly.",
  };

  it("reads back what toEvalCaseV1 stores", () => {
    const stored = toEvalCaseV1(body);
    expect(readEvalCaseBody(stored.input, stored.expectations)).toEqual(body);
  });

  it("is null for a shape it can't edit", () => {
    const stored = toEvalCaseV1(body);
    expect(readEvalCaseBody({ ...stored.input, schemaVersion: 2 }, stored.expectations)).toBeNull();
    expect(readEvalCaseBody(stored.input, {})).toBeNull();
  });
});

describe("hasEvalCasePassed", () => {
  it("passes only when every one of k attempts passed", () => {
    expect(hasEvalCasePassed(3, 3)).toBe(true);
    expect(hasEvalCasePassed(2, 3)).toBe(false);
    expect(hasEvalCasePassed(0, 0)).toBe(false);
  });
});
