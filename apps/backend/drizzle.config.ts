import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// DEV_NOTE: DATABASE_URL is the direct Neon URL (not Hyperdrive). Locally it comes from
// apps/backend/.env (Neon staging branch). A DATABASE_URL already set in the shell wins,
// which is how production migrations are run.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "./src/db/tables.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
