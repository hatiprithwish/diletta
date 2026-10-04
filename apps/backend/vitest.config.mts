import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// DEV_NOTE: Loads CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE (Neon staging) so tests run on Postgres.
const envFile = path.resolve(import.meta.dirname, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// DEV_NOTE: pg is CommonJS, but the Workers pool resolves its require() calls with ESM conditions:
// pg-protocol loads its ESM build (fails to parse) and pg-cloudflare its .mjs (CloudflareSocket undefined).
// Pin both to their CommonJS builds. Test-only; wrangler's bundler resolves these correctly.
const requireFromPg = createRequire(createRequire(import.meta.url).resolve("pg"));
const pgProtocolCjs = requireFromPg.resolve("pg-protocol");
const pgCloudflareCjs = path.join(
  path.dirname(requireFromPg.resolve("pg-cloudflare/package.json")),
  "dist/index.js",
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@app/schemas": path.resolve(import.meta.dirname, "../../packages/schemas/src/index.ts"),
      "pg-protocol": pgProtocolCjs,
      "pg-cloudflare": pgCloudflareCjs,
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },
});
