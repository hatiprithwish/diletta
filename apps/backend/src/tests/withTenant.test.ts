import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import getDbClient from "@/db/dbClient";
import { chatbots, companies } from "@/db/tables";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import withPlatform from "@/db/withPlatform";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import Utility from "@/utils/Utility";
import type * as Schemas from "@app/schemas";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Tests hit the Neon staging branch. Two fresh companies per run isolate rows;
// afterAll deletes every chatbot and company this suite created. Workers allow 6 open
// connections: the shared client opens at most 2 (the concurrent test), plus one test pool
// at a time (at most 3), and every pool is ended. Don't add a pool, e.g. via a Repo, without
// recounting. The code under test runs as diletta_app (HYPERDRIVE); fixtures and cleanup run as
// the owner, on a pool of 1 opened only in beforeAll / afterAll.
const db = getDbClient(env);
// DEV_NOTE: Test-only bindings from apps/backend/.env, passed in by vitest.config.mts. Read through `in`
// narrowing so neither the worker's Env nor a test-only type has to declare them.
const neonPoolerUrl =
  "NEON_POOLER_URL" in env && typeof env.NEON_POOLER_URL === "string" ? env.NEON_POOLER_URL : "";
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let companyA = "";
let companyB = "";

const readCompanySetting = sql`select current_setting('app.company_id', true) as "companyId"`;
const readPlatformSetting = sql`select current_setting('app.is_platform', true) as "isPlatform"`;

async function readSetting(client: NodePgDatabase): Promise<string> {
  const { rows } = await client.execute<{ companyId: string | null }>(readCompanySetting);
  return rows[0]?.companyId ?? "";
}

async function readPlatformFlag(client: NodePgDatabase): Promise<string> {
  const { rows } = await client.execute<{ isPlatform: string | null }>(readPlatformSetting);
  return rows[0]?.isPlatform ?? "";
}

// DEV_NOTE: max 1 forces every query onto the connection the previous transaction used,
// so anything a transaction leaves behind on the session shows up in the next query.
// The connection must be direct: through a pooler, a session-level setting (negative control below)
// would land on a shared server connection.
async function withSingleConnection(run: (client: NodePgDatabase) => Promise<void>) {
  expect(new URL(env.HYPERDRIVE.connectionString).hostname).not.toContain("-pooler.");
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Test company A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Test company B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
  });
});

afterAll(async () => {
  try {
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await db.$client.end();
  }
});

describe("withTenant", () => {
  it("sets app.company_id inside the transaction and clears it after, on the same connection", async () => {
    await withSingleConnection(async (client) => {
      const inside = await withTenant(client, companyA, async (tx) => ({
        isSuccess: true,
        message: await readSetting(tx),
      }));
      expect(inside).toEqual({ isSuccess: true, message: companyA });

      expect(await readSetting(client)).toBe("");
    });
  });

  it("keeps concurrent tenant transactions isolated", async () => {
    const readAfterSleep = (companyId: string) =>
      withTenant(db, companyId, async (tx) => {
        await tx.execute(sql`select pg_sleep(0.1)`);
        return { isSuccess: true, message: await readSetting(tx) };
      });

    const [resultA, resultB] = await Promise.all([
      readAfterSleep(companyA),
      readAfterSleep(companyB),
    ]);
    expect(resultA.message).toBe(companyA);
    expect(resultB.message).toBe(companyB);
  });

  it("rolls back every write when the callback throws", async () => {
    const dal = new ChatbotsDAL();
    const name = `Rolled back ${crypto.randomUUID()}`;

    const result = await withTenant(db, companyA, async (tx) => {
      const created = await dal.createChatbot(tx, { companyId: companyA, name });
      expect(created.isSuccess).toBe(true);
      throw new TenantRollbackError("Forced rollback");
    });
    expect(result).toEqual({ isSuccess: false, message: "Forced rollback" });

    const unexpected = await withTenant(db, companyA, async () => {
      throw new Error("boom");
    });
    expect(unexpected).toEqual({
      isSuccess: false,
      message: "Unknown error in tenant transaction",
    });

    const listed = await withTenant(db, companyA, (tx) =>
      dal.getChatbots(tx, { companyId: companyA }),
    );
    expect(listed.isSuccess).toBe(true);
    if (!("chatbots" in listed) || !listed.chatbots) {
      throw new Error("getChatbots returned no chatbots list");
    }
    expect(listed.chatbots.some((chatbot) => chatbot.name === name)).toBe(false);
  });

  it("rejects a malformed company id without opening a transaction", async () => {
    const invalidIds = ["", " ", "abc", "-1", "01", "1.5", "1e3", "9223372036854775808"];

    const transaction = vi.spyOn(db, "transaction");
    try {
      for (const companyId of invalidIds) {
        const callback = vi.fn(async () => ({ isSuccess: true }));
        const result = await withTenant(db, companyId, callback);
        expect(result).toEqual({ isSuccess: false, message: "Invalid company id" });
        expect(callback).not.toHaveBeenCalled();
      }
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it("rejects a non-string company id from an untyped caller instead of throwing", async () => {
    const transaction = vi.spyOn(db, "transaction");
    try {
      for (const companyId of [undefined, null, 42, { id: "1" }]) {
        const callback = vi.fn(async () => ({ isSuccess: true }));
        // DEV_NOTE: Reflect.apply calls withTenant the way an untyped caller would, past its string type
        const result: Schemas.ApiResponse = await Reflect.apply(withTenant, undefined, [
          db,
          companyId,
          callback,
        ]);
        expect(result).toEqual({ isSuccess: false, message: "Invalid company id" });
        expect(callback).not.toHaveBeenCalled();
      }
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it("accepts canonical ids up to int64 max", async () => {
    const validIds = ["0", "1", "1000000000000000000", "9223372036854775807"];

    for (const companyId of validIds) {
      const result = await withTenant(db, companyId, async (tx) => ({
        isSuccess: true,
        message: await readSetting(tx),
      }));
      expect(result).toEqual({ isSuccess: true, message: companyId });
    }
  });
});

describe("withTenant context leak on pooled connections", () => {
  // DEV_NOTE: Negative control. Proves the single-connection check below detects a leak:
  // a session-level set_config (third arg false) does survive into the next query.
  // RESET in finally clears it before the pool ends, in case a pooler keeps the server session.
  it("detects a session-level setting on the reused connection", async () => {
    await withSingleConnection(async (client) => {
      try {
        await client.execute(sql`select set_config('app.company_id', ${companyA}, false)`);
        expect(await readSetting(client)).toBe(companyA);
      } finally {
        await client.execute(sql`reset app.company_id`);
      }
      expect(await readSetting(client)).toBe("");
    });
  });

  it("leaves no context behind after a rollback, an unexpected throw or a SQL error", async () => {
    await withSingleConnection(async (client) => {
      const rolledBack = await withTenant(client, companyA, async () => {
        throw new TenantRollbackError("Forced rollback");
      });
      expect(rolledBack).toEqual({ isSuccess: false, message: "Forced rollback" });
      expect(await readSetting(client)).toBe("");

      const thrown = await withTenant(client, companyA, async () => {
        throw new Error("boom");
      });
      expect(thrown.isSuccess).toBe(false);
      expect(await readSetting(client)).toBe("");

      // DEV_NOTE: division by zero aborts the transaction server-side before COMMIT is reached
      const aborted = await withTenant(client, companyA, async (tx) => {
        await tx.execute(sql`select 1 / 0`);
        return { isSuccess: true };
      });
      expect(aborted).toEqual({ isSuccess: false, message: "Unknown error in tenant transaction" });
      expect(await readSetting(client)).toBe("");
    });
  });

  it("gives each transaction only its own company when they alternate on one connection", async () => {
    await withSingleConnection(async (client) => {
      for (let i = 0; i < 20; i++) {
        const companyId = i % 2 === 0 ? companyA : companyB;
        const result = await withTenant(client, companyId, async (tx) => ({
          isSuccess: true,
          message: await readSetting(tx),
        }));
        expect(result).toEqual({ isSuccess: true, message: companyId });
      }
      expect(await readSetting(client)).toBe("");
    });
  });

  // DEV_NOTE: Local tests skip Hyperdrive's pool, so this runs through Neon's -pooler endpoint:
  // PgBouncer in transaction mode, which hands server connections out per transaction like
  // Hyperdrive does. Server connections are shared, so a leak would surface in a plain query.
  // pg_backend_pid() is the server backend behind PgBouncer: it proves the pooler really handed
  // one backend to both companies, and a backend to a plain read after a tenant transaction, so the
  // test can't pass on backends pinned to one client.
  // No session-level negative control here: it would leave a company id on shared staging backends.
  it("keeps contexts isolated across a transaction-mode pooler", async () => {
    if (!neonPoolerUrl) {
      throw new Error(
        "Set NEON_POOLER_URL in apps/backend/.env (Neon staging connection string, -pooler host)",
      );
    }
    expect(new URL(neonPoolerUrl).hostname).toContain("-pooler.");

    const pool = new Pool({ connectionString: neonPoolerUrl, max: 3 });
    const pooledDb = drizzle({ client: pool });
    // DEV_NOTE: backend pid → what it served, in order: a company id, or "" for a plain read.
    // A backend runs one transaction at a time, so the order recorded here is the order it served.
    const servedByBackend = new Map<number, string[]>();
    const markServed = (pid: number, served: string) => {
      servedByBackend.set(pid, [...(servedByBackend.get(pid) ?? []), served]);
    };

    try {
      const tenantRead = async (companyId: string) => {
        const result = await withTenant(pooledDb, companyId, async (tx) => {
          const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          markServed(rows[0]!.pid, companyId);
          const first = await readSetting(tx);
          await tx.execute(sql`select pg_sleep(0.05)`);
          const second = await readSetting(tx);
          return { isSuccess: first === second, message: second };
        });
        return { expected: companyId, actual: result };
      };
      // DEV_NOTE: pid and setting in one statement, so both come from the same backend
      const plainRead = async () => {
        const { rows } = await pooledDb.execute<{ pid: number; companyId: string | null }>(
          sql`select pg_backend_pid() as pid, current_setting('app.company_id', true) as "companyId"`,
        );
        markServed(rows[0]!.pid, "");
        return { expected: "", actual: { isSuccess: true, message: rows[0]?.companyId ?? "" } };
      };

      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          if (i % 4 === 3) return plainRead();
          return tenantRead(i % 2 === 0 ? companyA : companyB);
        }),
      );
      for (const { expected, actual } of results) {
        expect(actual).toEqual({ isSuccess: true, message: expected });
      }

      const after = await Promise.all(Array.from({ length: 8 }, () => plainRead()));
      for (const { actual } of after) {
        expect(actual).toEqual({ isSuccess: true, message: "" });
      }

      const backends = [...servedByBackend.values()];
      expect(
        backends.some((served) => served.includes(companyA) && served.includes(companyB)),
      ).toBe(true);
      const plainReadAfterTenant = (served: string[]) => {
        const firstTenant = served.findIndex((entry) => entry !== "");
        return firstTenant !== -1 && served.lastIndexOf("") > firstTenant;
      };
      expect(backends.some(plainReadAfterTenant)).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

describe("withPlatform", () => {
  it("sets app.is_platform inside the transaction and clears it after, on the same connection", async () => {
    await withSingleConnection(async (client) => {
      const inside = await withPlatform(client, async (tx) => ({
        isSuccess: (await readSetting(tx)) === "",
        message: await readPlatformFlag(tx),
      }));
      expect(inside).toEqual({ isSuccess: true, message: "on" });

      expect(await readPlatformFlag(client)).toBe("");
    });
  });

  it("leaves no flag behind after a rollback, an unexpected throw or a SQL error", async () => {
    await withSingleConnection(async (client) => {
      const rolledBack = await withPlatform(client, async () => {
        throw new TenantRollbackError("Forced rollback");
      });
      expect(rolledBack).toEqual({ isSuccess: false, message: "Forced rollback" });
      expect(await readPlatformFlag(client)).toBe("");

      const thrown = await withPlatform(client, async () => {
        throw new Error("boom");
      });
      expect(thrown).toEqual({
        isSuccess: false,
        message: "Unknown error in platform transaction",
      });
      expect(await readPlatformFlag(client)).toBe("");

      const aborted = await withPlatform(client, async (tx) => {
        await tx.execute(sql`select 1 / 0`);
        return { isSuccess: true };
      });
      expect(aborted.isSuccess).toBe(false);
      expect(await readPlatformFlag(client)).toBe("");
    });
  });

  it("never carries the platform flag into a tenant transaction, or a company into a platform one", async () => {
    await withSingleConnection(async (client) => {
      for (let i = 0; i < 10; i++) {
        const platform = await withPlatform(client, async (tx) => ({
          isSuccess: true,
          message: `${await readPlatformFlag(tx)}|${await readSetting(tx)}`,
        }));
        expect(platform).toEqual({ isSuccess: true, message: "on|" });

        const tenant = await withTenant(client, companyA, async (tx) => ({
          isSuccess: true,
          message: `${await readPlatformFlag(tx)}|${await readSetting(tx)}`,
        }));
        expect(tenant).toEqual({ isSuccess: true, message: `|${companyA}` });
      }
    });
  });
});
