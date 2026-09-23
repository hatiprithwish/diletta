import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/tables.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  driver: "d1-http",
});
