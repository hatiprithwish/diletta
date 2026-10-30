import { z } from "zod";
import { CURRENT_CONFIG_SCHEMA_VERSION, ZConfigSpecBody } from "./configSpec";
import {
  EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
  EVAL_CASE_INPUT_SCHEMA_VERSION,
  ZEvalCaseExpectationsV2,
  ZEvalCaseInputV1,
  ZEvalCaseTag,
} from "./evalCases";
import { ZEvalApiContract, ZEvalHarnessConstants } from "./evalHarness";
import {
  EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
  EVAL_TRANSCRIPT_SCHEMA_VERSION,
  ZEvalGraderOutputV1,
  ZEvalTranscriptV1,
} from "./evalResults";

// DEV_NOTE: Zod → JSON Schema for the Python eval harness in evals/ (it can't import TypeScript). Each entry is
// written to evals/schemas/<fileName> by `pnpm --filter @app/schemas schema:export` and committed; the drift test
// (jsonSchemaExports.test.ts) fails when a committed file no longer matches its Zod schema. io "input" = what a
// client sends. M4-8 adds what the harness writes for the Tests page (grader output, transcript); M5-1 the eval case
// (input, expectations at the current version: the harness gets cases already upgraded, and the placeholder its
// messages and values carry); M5-2 the /eval/* API (every request and answer, one model per message) and the
// constants the harness needs that no message carries (each a literal, read from its generated type). evals/diletta_evals/types/ is generated from these files (`pnpm evals:types`), and
// `pnpm evals:check` fails when it no longer matches them or the samples in jsonSchemaContractSamples.ts.
// The JSON Schema is NOT the full contract: refinements (superRefine) have no JSON Schema form and are dropped.
// For the config spec that is: no duplicate procedure / tool / knowledge source, approval rules name only pinned
// tools; for eval case expectations: at least one check, forbidden tools unique and never expected, a readback per
// tool at most and only of a tool expected exactly once, the whole body ≤ EVAL_CASE_EXPECTATIONS_MAX_CHARS as JSON,
// and the reserved tool name; for the eval API: a passing result has no grader error, and a case's messages end with
// the user's (the counts of args / expect values, at most EVAL_CASE_MAX_VALUES and at least one
// expect value, are exported as maxProperties / minProperties). Numbers are JSON numbers on both sides (float in
// Python): when the harness compares an expected value with what it read, it must compare JSON types too, since in
// Python True == 1 and 1 == 1.0. A body valid against the JSON Schema can still be rejected by loadConfigSpec / normalizeConfigBody.
export interface JsonSchemaExport {
  fileName: string;
  title: string;
  description: string;
  schema: z.ZodType;
}

export const JSON_SCHEMA_EXPORTS: JsonSchemaExport[] = [
  {
    fileName: "config-spec.schema.json",
    title: "ConfigSpec",
    description: `chatbot_configs.body at schema_version ${CURRENT_CONFIG_SCHEMA_VERSION}`,
    schema: ZConfigSpecBody,
  },
  {
    fileName: "eval-grader-output.schema.json",
    title: "EvalGraderOutput",
    description: `eval_results.grader_output at schemaVersion ${EVAL_GRADER_OUTPUT_SCHEMA_VERSION}`,
    schema: ZEvalGraderOutputV1,
  },
  {
    fileName: "eval-transcript.schema.json",
    title: "EvalTranscript",
    description: `An eval attempt's transcript file in R2 (files.owner_type eval_result) at schemaVersion ${EVAL_TRANSCRIPT_SCHEMA_VERSION}`,
    schema: ZEvalTranscriptV1,
  },
  {
    fileName: "eval-case-input.schema.json",
    title: "EvalCaseInput",
    description: `eval_cases.input at schemaVersion ${EVAL_CASE_INPUT_SCHEMA_VERSION}`,
    schema: ZEvalCaseInputV1,
  },
  {
    fileName: "eval-case-expectations.schema.json",
    title: "EvalCaseExpectations",
    description: `eval_cases.expectations at schemaVersion ${EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION} (older bodies upgraded by loadEvalCaseExpectations)`,
    schema: ZEvalCaseExpectationsV2,
  },
  {
    fileName: "eval-api.schema.json",
    title: "EvalApi",
    description:
      "The eval harness's /eval/* API (M5-2): every request body and answer, by name; the root object is never sent",
    schema: ZEvalApiContract,
  },
  {
    fileName: "eval-case-tag.schema.json",
    title: "EvalCaseTag",
    description:
      "The placeholder an eval case's messages, rules and expected values carry; the harness fills it with one unique token per attempt",
    schema: ZEvalCaseTag,
  },
  {
    fileName: "eval-constants.schema.json",
    title: "EvalHarnessConstants",
    description:
      "Constants the harness needs that no request or answer carries (the eval JWT, headers, the test host's token), each a literal: read by the harness, never sent",
    schema: ZEvalHarnessConstants,
  },
];

export function buildJsonSchema(entry: JsonSchemaExport): Record<string, unknown> {
  return {
    ...z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" }),
    title: entry.title,
    description: entry.description,
  };
}
