import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createTestHostTestBindings } from "../test-host/testBindings";

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

// DEV_NOTE: The test host (M3-3, docs/runbooks/test-host.md) runs next to the worker as an auxiliary worker: its own
// bundle (`pnpm --filter test-host build`, run by this package's test script) with its Durable Object, fresh secrets
// per run, reached only through the TEST_HOST service binding (tests pass TEST_HOST.fetch as the adapter's fetch, so
// nothing goes over the network). compatibilityDate = apps/test-host/wrangler.jsonc's. The bundle goes in as `script`
// (its text): under the Workers pool a `scriptPath` worker fails to start.
const testHostScript = path.resolve(import.meta.dirname, "../test-host/dist/index.js");
if (!existsSync(testHostScript)) {
  throw new Error("Test host bundle missing: run `pnpm --filter test-host build` first");
}
const testHostBindings = await createTestHostTestBindings();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // DEV_NOTE: No remote proxy session: the AI binding (Workers AI, M2-5) would otherwise open one on the platform's
      // Cloudflare account at startup. No test reaches Workers AI; they mock the knowledge providers that call it.
      remoteBindings: false,
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
          TEST_HOST_ISSUER: testHostBindings.TEST_HOST_ISSUER,
          TEST_HOST_ADMIN_SECRET: testHostBindings.TEST_HOST_ADMIN_SECRET,
        },
        serviceBindings: { TEST_HOST: "test-host" },
        workers: [
          {
            name: "test-host",
            modules: true,
            script: readFileSync(testHostScript, "utf8"),
            compatibilityDate: "2026-06-11",
            durableObjects: {
              TEST_HOST_WORKSPACE_DO: { className: "TestHostWorkspaceDO", useSQLite: true },
            },
            bindings: { ...testHostBindings },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@app/adapter": path.resolve(import.meta.dirname, "../../packages/adapter/src/index.ts"),
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
