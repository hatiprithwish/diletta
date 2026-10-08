import { describe, it, expect } from "vitest";
import configSpecJsonSchema from "../../../evals/schemas/config-spec.schema.json";
import { buildJsonSchema, JSON_SCHEMA_EXPORTS } from "./jsonSchemaExports";

// DEV_NOTE: The committed files in evals/schemas/, by file name. A new JSON_SCHEMA_EXPORTS entry adds its import
// here after its first `pnpm --filter @app/schemas schema:export`.
const COMMITTED: Record<string, unknown> = {
  "config-spec.schema.json": configSpecJsonSchema,
};

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
