import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import * as Schemas from "@app/schemas";
import { loadDevKey, signDevToken } from "./scripts/devJwt.ts";

// DEV_NOTE: Three outputs from one config:
//   `vite`              the dev host (index.html → src/dev/), a stand-in host page on WIDGET_DEV_PORT
//   `vite build`        dist/embed/diletta-widget.js, the script-tag build (IIFE, React bundled in), served by the
//                       static Worker in wrangler.jsonc
//   `vite build --mode lib`  dist/lib/index.js, <DilettaWidget /> as an ES module for React hosts (React external)
// Styles are compiled into the JS (?inline) and injected into the widget's shadow root, never the host page.

// DEV_NOTE: Development only: the dev host's stand-in for a host backend's token endpoint
function devTokenEndpoint(): Plugin {
  return {
    name: "diletta-dev-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev/token", async (_request, response) => {
        const devKey = await loadDevKey();
        if (!devKey) {
          response.statusCode = 503;
          response.end("Run `pnpm --filter widget dev:setup --company <companyPublicId>` first");
          return;
        }
        response.setHeader("Content-Type", "text/plain");
        response.setHeader("Cache-Control", "no-store");
        response.end(await signDevToken(devKey, { sub: "widget-dev-user", name: "Priya Shah" }));
      });
    },
  };
}

const alias = [
  { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
  {
    find: "@app/schemas",
    replacement: path.resolve(import.meta.dirname, "../../packages/schemas/src/index.ts"),
  },
  // shadcn components import bare `cn`; route it to the theme-aware instance in packages/ui
  {
    find: /^cn$/,
    replacement: path.resolve(import.meta.dirname, "../../packages/ui/src/lib/utils.ts"),
  },
];

export default defineConfig(({ command, mode }) => {
  const isLib = mode === "lib";
  return {
    plugins: [react(), tailwindcss(), devTokenEndpoint()],
    resolve: { alias },
    server: { port: Schemas.WIDGET_DEV_PORT, strictPort: true },
    // DEV_NOTE: Library builds don't replace process.env.NODE_ENV on their own; React needs it to drop its dev build
    define:
      command === "build" ? { "process.env.NODE_ENV": JSON.stringify("production") } : undefined,
    build: isLib
      ? {
          outDir: "dist/lib",
          copyPublicDir: false,
          emptyOutDir: true,
          lib: {
            entry: path.resolve(import.meta.dirname, "src/index.ts"),
            formats: ["es"],
            fileName: () => "index.js",
          },
          rollupOptions: { external: ["react", "react-dom", "react/jsx-runtime"] },
        }
      : {
          outDir: "dist/embed",
          emptyOutDir: true,
          copyPublicDir: true,
          lib: {
            entry: path.resolve(import.meta.dirname, "src/embed.tsx"),
            formats: ["iife"],
            name: "DilettaWidgetBundle",
            fileName: () => "diletta-widget.js",
          },
        },
  };
});
