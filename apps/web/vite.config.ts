import { defineConfig, loadEnv } from "vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tanstackStart(),
      sentryTanstackStart({
        org: env.SENTRY_ORG,
        project: env.SENTRY_PROJECT,
        authToken: env.SENTRY_AUTH_TOKEN,
        tunnelRoute: true,
      }),
      viteReact(),
      tailwindcss(),
    ],
    server: {
      port: 3000,
    },
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@app/schemas": path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
      },
    },
  };
});
