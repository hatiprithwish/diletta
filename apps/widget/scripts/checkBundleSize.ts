import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The widget's bundle budget (WIDGET_BUNDLE_MAX_GZIP_BYTES, dev plan open question M2-7): the script-tag build
// is what every host page downloads, so `pnpm --filter widget build` fails when its gzipped size goes over it.
const BUNDLE_PATH = path.resolve(import.meta.dirname, "../dist/embed/diletta-widget.js");

const bytes = gzipSync(await readFile(BUNDLE_PATH), { level: 9 }).byteLength;
const kib = (value: number) => `${(value / 1024).toFixed(1)} KiB`;

if (bytes > Schemas.WIDGET_BUNDLE_MAX_GZIP_BYTES) {
  process.stderr.write(
    `diletta-widget.js is ${kib(bytes)} gzipped, over the ${kib(Schemas.WIDGET_BUNDLE_MAX_GZIP_BYTES)} budget\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `diletta-widget.js: ${kib(bytes)} gzipped (budget ${kib(Schemas.WIDGET_BUNDLE_MAX_GZIP_BYTES)})\n`,
);
