import { mkdir, writeFile } from "node:fs/promises";
import { JSON_SCHEMA_CONTRACT_SAMPLES } from "../src/jsonSchemaContractSamples";
import { buildJsonSchema, JSON_SCHEMA_EXPORTS } from "../src/jsonSchemaExports";

// DEV_NOTE: Writes every JSON_SCHEMA_EXPORTS entry to <repo>/evals/schemas/ and the contract samples to
// <repo>/evals/fixtures/contract-samples.json. Run after any change to an exported Zod schema or a sample, then
// `pnpm evals:types`, and commit the output with it; the drift tests fail until then.
const outDir = new URL("../../../evals/schemas/", import.meta.url);
const fixturesDir = new URL("../../../evals/fixtures/", import.meta.url);

await mkdir(outDir, { recursive: true });
for (const entry of JSON_SCHEMA_EXPORTS) {
  const json = `${JSON.stringify(buildJsonSchema(entry), null, 2)}\n`;
  await writeFile(new URL(entry.fileName, outDir), json);
  process.stdout.write(`Wrote evals/schemas/${entry.fileName}\n`);
}

await mkdir(fixturesDir, { recursive: true });
await writeFile(
  new URL("contract-samples.json", fixturesDir),
  `${JSON.stringify(JSON_SCHEMA_CONTRACT_SAMPLES, null, 2)}\n`,
);
process.stdout.write("Wrote evals/fixtures/contract-samples.json\n");
