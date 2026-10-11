import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";
import { createTestHostTestBindings } from "./testBindings";

// DEV_NOTE: The test host's own tests run it in workerd (its Durable Object included). Secrets and issuer come from
// testBindings.ts (fresh per run), overriding .dev.vars.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ...(await createTestHostTestBindings()) } },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@app/schemas": path.resolve(import.meta.dirname, "../../packages/schemas/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },
});
