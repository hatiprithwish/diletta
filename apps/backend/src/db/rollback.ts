import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

// DEV_NOTE: Rolls back the last N applied migrations (default 1): runs each folder's down.sql and deletes its row
// from drizzle.__drizzle_migrations, newest first, all in one transaction. drizzle-kit migrate tracks applied
// migrations by folder name, so a rolled-back migration re-applies on the next db:migrate.
// Runs in Node (pnpm --filter backend db:rollback [steps]), not in the worker, so it uses no @/ aliases or
// AppLogger and writes to stdout/stderr. DATABASE_URL comes from apps/backend/.env unless already set in the
// shell, same as drizzle.config.ts.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "migrations");
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

async function rollback(steps: number) {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ name: string | null }>(
      "SELECT name FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT $1",
      [steps],
    );
    if (rows.length < steps) {
      throw new Error(`Only ${rows.length} applied migration(s); can't roll back ${steps}`);
    }

    for (const { name } of rows) {
      if (!name) {
        throw new Error(
          "Applied migration has no name; run db:migrate once to upgrade the journal",
        );
      }
      const downPath = path.join(MIGRATIONS_DIR, name, "down.sql");
      if (!existsSync(downPath)) {
        throw new Error(`${name} has no down.sql`);
      }
      const statements = readFileSync(downPath, "utf8")
        .split(STATEMENT_BREAKPOINT)
        .filter((statement) => statement.trim().length > 0);
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query("DELETE FROM drizzle.__drizzle_migrations WHERE name = $1", [name]);
      process.stdout.write(`Rolled back ${name}\n`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

const steps = Number(process.argv[2] ?? "1");
if (!Number.isInteger(steps) || steps < 1) {
  process.stderr.write("Usage: db:rollback [steps], steps is a positive integer\n");
  process.exit(1);
}

rollback(steps).catch((error: unknown) => {
  process.stderr.write(
    `Rollback failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
