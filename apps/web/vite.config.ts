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
        // DEV_NOTE: SSR runs in workerd, not the Node process instrument.server.mjs inits, so the tunnel route
        // finds no server client to read the DSN from; it gets the (public) browser DSN here instead
        tunnelRoute: env.VITE_SENTRY_DSN ? { allowedDsns: [env.VITE_SENTRY_DSN] } : true,
      }),
      viteReact(),
      tailwindcss(),
    ],
    server: {
      port: 3000,
    },
    resolve: {
      tsconfigPaths: true,
      alias: [
        { find: "@", replacement: path.resolve(__dirname, "./src") },
        {
          find: "@app/schemas",
          replacement: path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
        },
        // shadcn components import bare `cn`; route it to the theme-aware instance in packages/ui
        {
          find: /^cn$/,
          replacement: path.resolve(__dirname, "../../packages/ui/src/lib/utils.ts"),
        },
      ],
    },
  };
});
