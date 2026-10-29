import { z } from "zod";
import { CURRENT_CONFIG_SCHEMA_VERSION, ZConfigSpecBody } from "./configSpec";
import {
  EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
  EVAL_CASE_INPUT_SCHEMA_VERSION,
  ZEvalCaseExpectationsV2,
  ZEvalCaseInputV1,
  ZEvalCaseTag,
} from "./evalCases";
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
// messages and values carry). evals/diletta_evals/types/ is generated from these files (`pnpm evals:types`), and
// `pnpm evals:check` fails when it no longer matches them or the samples in jsonSchemaContractSamples.ts.
// The JSON Schema is NOT the full contract: refinements (superRefine) have no JSON Schema form and are dropped.
// For the config spec that is: no duplicate procedure / tool / knowledge source, approval rules name only pinned
// tools; for eval case expectations: at least one check, the tool rules of ZEvalCaseExpectationsV2, a reserved tool
// name. A body valid against the JSON Schema can still be rejected by loadConfigSpec / normalizeConfigBody.
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
    fileName: "eval-case-tag.schema.json",
    title: "EvalCaseTag",
    description:
      "The placeholder an eval case's messages, rules and expected values carry; the harness fills it with one unique token per attempt",
    schema: ZEvalCaseTag,
  },
];

export function buildJsonSchema(entry: JsonSchemaExport): Record<string, unknown> {
  return {
    ...z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" }),
    title: entry.title,
    description: entry.description,
  };
}
