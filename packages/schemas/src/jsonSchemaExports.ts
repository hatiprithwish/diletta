import { z } from "zod";
import { CURRENT_CONFIG_SCHEMA_VERSION, ZConfigSpec } from "./configSpec";

// DEV_NOTE: Zod → JSON Schema for the Python eval harness in evals/ (it can't import TypeScript). Each entry is
// written to evals/schemas/<fileName> by `pnpm --filter @app/schemas schema:export` and committed; the drift test
// (jsonSchemaExports.test.ts) fails when a committed file no longer matches its Zod schema. io "input" = the
// stored shape, so fields with a platform default are optional. M5 adds the eval case schemas here.
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
    schema: ZConfigSpec,
  },
];

export function buildJsonSchema(entry: JsonSchemaExport): Record<string, unknown> {
  return {
    ...z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" }),
    title: entry.title,
    description: entry.description,
  };
}
