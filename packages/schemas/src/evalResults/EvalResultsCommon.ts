import { z } from "zod";
import { EvalCaseMessageRoleEnum } from "../evalCases";
import { ToolCallStatusIntEnum } from "../toolCalls";

// DEV_NOTE: eval_results.grader_output is jsonb and the transcript is a JSON file in R2, both written by the eval
// harness (M5-2 / M5-3) and read by the Tests page (M4-8). Neither has a schema_version column, so each body carries
// its own schemaVersion. They are read only through parseEvalGraderOutput / parseEvalTranscript, which never throw: a
// body that fails them is shown as unreadable, never guessed at. A shape change adds a v2 with an upgrader here; a
// stored v1 body is never rewritten.
export const EVAL_GRADER_OUTPUT_SCHEMA_VERSION = 1;
export const EVAL_TRANSCRIPT_SCHEMA_VERSION = 1;

// DEV_NOTE: Sizes of a v1 grader output: how many checks one attempt has, a check's label and detail, and the error
// that stopped grading (an unreachable judge, M5-3)
export const EVAL_GRADER_MAX_CHECKS = 50;
export const EVAL_CHECK_LABEL_MAX_CHARS = 200;
export const EVAL_CHECK_DETAIL_MAX_CHARS = 1000;
export const EVAL_GRADER_ERROR_MAX_CHARS = 1000;

// DEV_NOTE: Sizes of a v1 transcript: the file (the backend refuses to read a bigger one), its entries, a message's
// text and a tool call's summary
export const EVAL_TRANSCRIPT_MAX_BYTES = 1024 * 1024;
export const EVAL_TRANSCRIPT_MAX_ENTRIES = 500;
export const EVAL_TRANSCRIPT_TEXT_MAX_CHARS = 20_000;
export const EVAL_TRANSCRIPT_SUMMARY_MAX_CHARS = 500;
export const EVAL_TRANSCRIPT_MIME = "application/json";

// DEV_NOTE: What one check of an attempt looked at. forbidden_tool: a tool the case says must never run; tool_call: a
// tool the case expects (with its args); readback: a record read back from the host after the run; judge: the pinned
// LLM judge on the rubric; rubric: a deterministic rule from the rubric (contains / doesn't contain).
export enum EvalCheckKindEnum {
  ForbiddenTool = "forbidden_tool",
  ToolCall = "tool_call",
  Readback = "readback",
  Judge = "judge",
  Rubric = "rubric",
}

// DEV_NOTE: label = what was checked, in the dashboard's words ("Never called delete_record"); detail = what the grader
// saw ("Read back in attempt 2: Open → Closed"), null when there is nothing to add. Both are written by the harness from
// the staging run, never from a live chat.
export const ZEvalCheckV1 = z.object({
  kind: z.enum(EvalCheckKindEnum),
  hasPassed: z.boolean(),
  label: z.string().trim().min(1).max(EVAL_CHECK_LABEL_MAX_CHARS),
  detail: z.string().trim().max(EVAL_CHECK_DETAIL_MAX_CHARS).nullable(),
});
export type EvalCheckV1 = z.infer<typeof ZEvalCheckV1>;

// DEV_NOTE: One attempt's grading. error set = grading couldn't finish (the attempt failed for that reason, whatever the
// checks say); checks holds what was graded before it stopped.
export const ZEvalGraderOutputV1 = z.object({
  schemaVersion: z.literal(EVAL_GRADER_OUTPUT_SCHEMA_VERSION),
  checks: z.array(ZEvalCheckV1).max(EVAL_GRADER_MAX_CHECKS),
  error: z.string().trim().min(1).max(EVAL_GRADER_ERROR_MAX_CHARS).nullable(),
});
export type EvalGraderOutputV1 = z.infer<typeof ZEvalGraderOutputV1>;
export type EvalGraderOutput = EvalGraderOutputV1;

// DEV_NOTE: The one way grader_output is read. null = absent or unreadable (the page says so).
export function parseEvalGraderOutput(value: unknown): EvalGraderOutput | null {
  const parsed = ZEvalGraderOutputV1.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export enum EvalTranscriptEntryKindEnum {
  Message = "message",
  ToolCall = "tool_call",
}

export const ZEvalTranscriptMessageV1 = z.object({
  kind: z.literal(EvalTranscriptEntryKindEnum.Message),
  role: z.enum(EvalCaseMessageRoleEnum),
  text: z.string().max(EVAL_TRANSCRIPT_TEXT_MAX_CHARS),
});

// DEV_NOTE: A tool call the chatbot made in the run: name, version, how it ended and a one-line summary (what the
// change request said, or why it failed). Never its args or values, like the Conversations transcript (M4-4).
export const ZEvalTranscriptToolCallV1 = z.object({
  kind: z.literal(EvalTranscriptEntryKindEnum.ToolCall),
  toolName: z.string().min(1).max(EVAL_CHECK_LABEL_MAX_CHARS),
  toolVersion: z.number().int().min(1),
  status: z.enum(ToolCallStatusIntEnum),
  summary: z.string().max(EVAL_TRANSCRIPT_SUMMARY_MAX_CHARS).nullable(),
});

// DEV_NOTE: One attempt's conversation, oldest first: the case's messages, then what the chatbot did and said
export const ZEvalTranscriptV1 = z.object({
  schemaVersion: z.literal(EVAL_TRANSCRIPT_SCHEMA_VERSION),
  entries: z
    .array(z.discriminatedUnion("kind", [ZEvalTranscriptMessageV1, ZEvalTranscriptToolCallV1]))
    .max(EVAL_TRANSCRIPT_MAX_ENTRIES),
});
export type EvalTranscriptV1 = z.infer<typeof ZEvalTranscriptV1>;
export type EvalTranscript = EvalTranscriptV1;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// DEV_NOTE: The one way a transcript file is read: UTF-8 JSON held to the schema. null = too big, not UTF-8, not JSON
// or not a transcript.
export function parseEvalTranscript(bytes: Uint8Array): EvalTranscript | null {
  if (bytes.byteLength > EVAL_TRANSCRIPT_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    return null;
  }
  const parsed = ZEvalTranscriptV1.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Whole Eval Result Body — DB shape
// DEV_NOTE: id, companyId, evalRunId, evalCaseId and transcriptFileId are internal bigint ids — used by DAL/Repo only,
// NEVER sent to a client (the transcript is addressed by its file's public id). Append-only, so no publicId:
// a result is found by (run, case, attempt). graderOutput is jsonb, read through parseEvalGraderOutput.
export const ZEvalResult = z.object({
  id: z.string(),
  companyId: z.string(),
  evalRunId: z.string(),
  evalCaseId: z.string(),
  attempt: z.number().int(),
  hasPassed: z.boolean(),
  graderOutput: z.unknown(),
  transcriptFileId: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  createdAt: z.date(),
});
export type EvalResult = z.infer<typeof ZEvalResult>;

// DEV_NOTE: Why a transcript can't be shown (422): the file is there but fails parseEvalTranscript
export enum EvalTranscriptFailureEnum {
  Unreadable = "Unreadable",
}

export const EVAL_TRANSCRIPT_FAILURE_HTTP_STATUS_MAP: Record<EvalTranscriptFailureEnum, 422> = {
  [EvalTranscriptFailureEnum.Unreadable]: 422,
};
