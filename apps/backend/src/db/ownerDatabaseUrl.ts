import { readFileSync } from "node:fs";
import path from "node:path";

// DEV_NOTE: Dev scripts only (`pnpm --filter widget dev:setup`, `pnpm --filter test-host seed`), never the worker or
// code under test: the owner role's connection string (DATABASE_URL, BYPASSRLS) read from apps/backend/.env, the
// staging branch. Those scripts write fixtures as the owner, like a test's setup.
export function readOwnerDatabaseUrl(): string {
  const lines = readFileSync(path.resolve(import.meta.dirname, "../../.env"), "utf8").split("\n");
  const line = lines.find((entry) => entry.trim().startsWith("DATABASE_URL="));
  const value = line
    ?.slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!value) throw new Error("DATABASE_URL is missing from apps/backend/.env");
  return value;
}
