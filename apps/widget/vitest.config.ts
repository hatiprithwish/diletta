import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: [
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
    ],
  },
});
