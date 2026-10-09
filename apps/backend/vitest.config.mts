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
      // DEV_NOTE: Test-only bindings, never declared in wrangler.jsonc. NEON_POOLER_URL: the withTenant
      // leak test runs through Neon's -pooler endpoint because local mode skips Hyperdrive's pool.
      // DATABASE_URL: the owner role (BYPASSRLS), for fixtures, cleanup and schema checks only; the code
      // under test runs as diletta_app through the HYPERDRIVE binding.
      // AI_GATEWAY_TOKEN: a fixed fake that replaces the real staging token from .dev.vars, so no test (or a Durable
      // Object a test drives) can reach AI Gateway on the platform's credentials; tests mock the gateway's fetch.
      miniflare: {
        bindings: {
          NEON_POOLER_URL: process.env.NEON_POOLER_URL ?? "",
          DATABASE_URL: process.env.DATABASE_URL ?? "",
          AI_GATEWAY_TOKEN: "test-gateway-token",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@app/crypto": path.resolve(import.meta.dirname, "../../packages/crypto/src/index.ts"),
      "@app/schemas": path.resolve(import.meta.dirname, "../../packages/schemas/src/index.ts"),
      "pg-protocol": pgProtocolCjs,
      "pg-cloudflare": pgCloudflareCjs,
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    // DEV_NOTE: Tests run real transactions against Neon staging over the network; each
    // withTenant call is several round trips, so multi-step tests exceed the 5s default.
    testTimeout: 30_000,
  },
});
