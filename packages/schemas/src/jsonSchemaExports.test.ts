import { describe, it, expect } from "vitest";
import contractSamplesFixture from "../../../evals/fixtures/contract-samples.json";
import configSpecJsonSchema from "../../../evals/schemas/config-spec.schema.json";
import evalApiJsonSchema from "../../../evals/schemas/eval-api.schema.json";
import evalCaseExpectationsJsonSchema from "../../../evals/schemas/eval-case-expectations.schema.json";
import evalCaseInputJsonSchema from "../../../evals/schemas/eval-case-input.schema.json";
import evalCaseTagJsonSchema from "../../../evals/schemas/eval-case-tag.schema.json";
import evalGraderOutputJsonSchema from "../../../evals/schemas/eval-grader-output.schema.json";
import evalTranscriptJsonSchema from "../../../evals/schemas/eval-transcript.schema.json";
import { JSON_SCHEMA_CONTRACT_SAMPLES } from "./jsonSchemaContractSamples";
import { buildJsonSchema, JSON_SCHEMA_EXPORTS } from "./jsonSchemaExports";

// DEV_NOTE: The committed files in evals/schemas/, by file name. A new JSON_SCHEMA_EXPORTS entry adds its import
// here after its first `pnpm --filter @app/schemas schema:export`.
const COMMITTED: Record<string, unknown> = {
  "config-spec.schema.json": configSpecJsonSchema,
  "eval-grader-output.schema.json": evalGraderOutputJsonSchema,
  "eval-transcript.schema.json": evalTranscriptJsonSchema,
  "eval-case-input.schema.json": evalCaseInputJsonSchema,
  "eval-case-expectations.schema.json": evalCaseExpectationsJsonSchema,
  "eval-case-tag.schema.json": evalCaseTagJsonSchema,
  "eval-api.schema.json": evalApiJsonSchema,
};

// DEV_NOTE: A sample as the Python side reads it (JSON: an undefined field is absent)
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("JSON Schema exports to evals/", () => {
  it("has a committed file for every export", () => {
    expect(Object.keys(COMMITTED).sort()).toEqual(
      JSON_SCHEMA_EXPORTS.map((entry) => entry.fileName).sort(),
    );
  });

  it.each(JSON_SCHEMA_EXPORTS)("evals/schemas/$fileName matches its Zod schema", (entry) => {
    const generated = JSON.parse(JSON.stringify(buildJsonSchema(entry)));
    expect(
      COMMITTED[entry.fileName],
      "Stale JSON Schema: run `pnpm --filter @app/schemas schema:export` and commit evals/schemas/",
    ).toEqual(generated);
  });

  it("exports the stored shape: platform-default sections are optional", () => {
    expect(configSpecJsonSchema.required).not.toContain("limits");
    expect(configSpecJsonSchema.required).not.toContain("attachments");
    expect(configSpecJsonSchema.required).toContain("persona");
  });
});

describe("JSON Schema contract samples", () => {
  it("has samples for every export, in the committed fixture", () => {
    expect(Object.keys(JSON_SCHEMA_CONTRACT_SAMPLES).sort()).toEqual(
      JSON_SCHEMA_EXPORTS.map((entry) => entry.fileName).sort(),
    );
    expect(
      contractSamplesFixture,
      "Stale samples: run `pnpm --filter @app/schemas schema:export` and commit evals/fixtures/",
    ).toEqual(asJson(JSON_SCHEMA_CONTRACT_SAMPLES));
  });

  it.each(JSON_SCHEMA_EXPORTS)("$fileName accepts its valid samples", (entry) => {
    const { valid } = JSON_SCHEMA_CONTRACT_SAMPLES[entry.fileName] ?? { valid: [] };
    expect(valid.length).toBeGreaterThan(0);
    for (const sample of valid) {
      expect(entry.schema.safeParse(asJson(sample)).success, JSON.stringify(sample)).toBe(true);
    }
  });

  it.each(JSON_SCHEMA_EXPORTS)("$fileName refuses its invalid samples", (entry) => {
    const { invalid } = JSON_SCHEMA_CONTRACT_SAMPLES[entry.fileName] ?? { invalid: [] };
    expect(invalid.length).toBeGreaterThan(0);
    for (const sample of invalid) {
      expect(entry.schema.safeParse(asJson(sample)).success, JSON.stringify(sample)).toBe(false);
    }
  });
});
