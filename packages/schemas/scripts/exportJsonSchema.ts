import { mkdir, writeFile } from "node:fs/promises";
import { buildJsonSchema, JSON_SCHEMA_EXPORTS } from "../src/jsonSchemaExports";

// DEV_NOTE: Writes every JSON_SCHEMA_EXPORTS entry to <repo>/evals/schemas/. Run after any change to an exported
// Zod schema and commit the output with it; the drift test fails until then.
const outDir = new URL("../../../evals/schemas/", import.meta.url);

await mkdir(outDir, { recursive: true });
for (const entry of JSON_SCHEMA_EXPORTS) {
  const json = `${JSON.stringify(buildJsonSchema(entry), null, 2)}\n`;
  await writeFile(new URL(entry.fileName, outDir), json);
  process.stdout.write(`Wrote evals/schemas/${entry.fileName}\n`);
}
