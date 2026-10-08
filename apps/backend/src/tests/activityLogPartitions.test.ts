import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import ActivityLogPartitionsRepo from "@/repositories/ActivityLogPartitionsRepo";
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

// DEV_NOTE: activity_log partition maintenance (M1-9) on the Neon staging branch. The Repo and the direct function
// calls run as diletta_app (HYPERDRIVE), the role the Cron uses, so the tests show the owner's rights reach it only
// through the SECURITY DEFINER functions. The owner connection (DATABASE_URL) only reads the catalog, counts
// partition rows (the app has no grant on partitions) and drops the partition the create test rebuilds.
// The partition set is shared by everyone on the staging branch: the create test drops only an empty partition
// (current month + 3, which no one writes to yet) and the Repo rebuilds it identically, so there is nothing to
// restore; afterAll recreates it as the owner in case the test died in between.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let ownerPool: Pool;
let ownerDb: NodePgDatabase;
let appPool: Pool;
let appDb: NodePgDatabase;

const DEFAULT_PARTITION = "activity_log_default";

function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function partitionName(start: Date): string {
  const month = String(start.getUTCMonth() + 1).padStart(2, "0");
  return `activity_log_y${start.getUTCFullYear()}m${month}`;
}

// DEV_NOTE: The owner session runs in UTC (beforeAll), so pg_get_expr prints bounds in this exact form
function partitionBound(start: Date): string {
  const end = monthStart(start, 1);
  const format = (date: Date) => `${date.toISOString().slice(0, 10)} 00:00:00+00`;
  return `FOR VALUES FROM ('${format(start)}') TO ('${format(end)}')`;
}

// DEV_NOTE: Drizzle wraps the pg error in DrizzleQueryError; the SQLSTATE is on its cause
async function sqlStateOf(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === "object" && current !== null) {
      if ("code" in current && typeof current.code === "string") return current.code;
      current = "cause" in current ? current.cause : undefined;
    }
    return "no SQLSTATE";
  }
  return undefined;
}

async function getPartitions(): Promise<Map<string, string>> {
  const { rows } = await ownerDb.execute<{ name: string; bound: string }>(sql`
    select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.activity_log'::regclass
  `);
  return new Map(rows.map((row) => [row.name, row.bound]));
}

async function countRows(table: string): Promise<number> {
  const { rows } = await ownerDb.execute<{ count: number }>(
    sql`select count(*)::int as count from ${sql.identifier(table)}`,
  );
  return rows[0].count;
}

async function countIndexes(table: string): Promise<number> {
  const { rows } = await ownerDb.execute<{ count: number }>(
    sql`select count(*)::int as count from pg_indexes where schemaname = 'public' and tablename = ${table}`,
  );
  return rows[0].count;
}

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  ownerDb = drizzle({ client: ownerPool });
  await ownerDb.execute(sql`set time zone 'UTC'`);
  appPool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  appDb = drizzle({ client: appPool });
});

afterAll(async () => {
  try {
    // DEV_NOTE: Backstop for a create test that dropped the partition and died before the Repo rebuilt it. DDL takes
    // no bind parameters, so the bound goes in as text; partitionBound builds it from a Date, never from input.
    const target = monthStart(new Date(), Constants.ACTIVITY_LOG_PARTITION_MONTHS_AHEAD);
    await ownerDb.execute(sql`
      create table if not exists ${sql.identifier(partitionName(target))}
      partition of activity_log ${sql.raw(partitionBound(target))}
    `);
  } finally {
    await appPool.end();
    await ownerPool.end();
  }
});

describe("partition maintenance functions", () => {
  it("run as the owner of activity_log, with a fixed search_path and UTC, executable by diletta_app only", async () => {
    const { rows } = await ownerDb.execute<{
      name: string;
      isSecurityDefiner: boolean;
      isOwnedByTableOwner: boolean;
      config: string[];
      grantees: string[];
    }>(sql`
      select p.proname as name, p.prosecdef as "isSecurityDefiner",
        p.proowner = (select relowner from pg_class where oid = 'public.activity_log'::regclass) as "isOwnedByTableOwner",
        coalesce(p.proconfig, '{}') as config,
        array(
          select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
          from aclexplode(p.proacl) a
          where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
          order by 1
        ) as grantees
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('create_activity_log_partition', 'activity_log_default_has_rows')
      order by p.proname
    `);

    expect(rows.map((row) => row.name)).toEqual([
      "activity_log_default_has_rows",
      "create_activity_log_partition",
    ]);
    for (const row of rows) {
      expect(row.isSecurityDefiner).toBe(true);
      expect(row.isOwnedByTableOwner).toBe(true);
      expect(row.config).toContain("search_path=pg_catalog, public, pg_temp");
      expect(row.grantees).toEqual(["diletta_app"]);
    }
    const create = rows.find((row) => row.name === "create_activity_log_partition");
    expect(create?.config).toContain("TimeZone=UTC");
  });

  it("leave diletta_app unable to create a partition itself", async () => {
    const { rows } = await appDb.execute<{ role: string }>(sql`select current_user as role`);
    expect(rows[0].role).toBe("diletta_app");

    const state = await sqlStateOf(
      appDb.execute(sql`
        create table activity_log_y2030m01 partition of activity_log
        for values from ('2030-01-01 00:00:00+00') to ('2030-02-01 00:00:00+00')
      `),
    );
    expect(state).toBe("42501");
  });

  it("reject a month that isn't a UTC month start, is already past, or is more than 12 months ahead", async () => {
    const now = new Date();
    const midMonth = new Date(monthStart(now, 1).getTime() + 15 * 24 * 60 * 60 * 1000);
    const cases = [midMonth, monthStart(now, -1), monthStart(now, 13)];

    for (const month of cases) {
      const state = await sqlStateOf(
        appDb.execute(
          sql`select * from create_activity_log_partition(${month.toISOString()}::timestamptz)`,
        ),
      );
      expect(state, month.toISOString()).toBe("22023");
    }
  });

  it("leave an existing partition alone", async () => {
    const current = monthStart(new Date(), 0);
    const { rows } = await appDb.execute<{ partition_name: string; was_created: boolean }>(
      sql`select * from create_activity_log_partition(${current.toISOString()}::timestamptz)`,
    );

    expect(rows).toEqual([{ partition_name: partitionName(current), was_created: false }]);
  });
});

describe("ActivityLogPartitionsRepo.ensurePartitions", () => {
  it("keeps the current month and the next three partitioned, and the default partition stays empty", async () => {
    const now = new Date();
    const result = await new ActivityLogPartitionsRepo(env).ensurePartitions({ now });

    expect(result).toMatchObject({ isSuccess: true, missingMonths: [], hasDefaultRows: false });

    const partitions = await getPartitions();
    for (let offset = 0; offset <= Constants.ACTIVITY_LOG_PARTITION_MONTHS_AHEAD; offset++) {
      const start = monthStart(now, offset);
      expect(partitions.get(partitionName(start))).toBe(partitionBound(start));
    }
    expect(partitions.get(DEFAULT_PARTITION)).toBe("DEFAULT");
    expect(await countRows(DEFAULT_PARTITION)).toBe(0);
  });

  it("recreates a missing month with the parent's bounds and indexes and no grants", async ({
    skip,
  }) => {
    const now = new Date();
    const target = monthStart(now, Constants.ACTIVITY_LOG_PARTITION_MONTHS_AHEAD);
    const name = partitionName(target);
    const sibling = partitionName(monthStart(now, 0));

    const partitions = await getPartitions();
    if (partitions.has(name) && (await countRows(name)) > 0) {
      skip("the target partition holds rows; dropping it would lose them");
    }
    await ownerDb.execute(sql`drop table if exists ${sql.identifier(name)}`);
    expect((await getPartitions()).has(name)).toBe(false);

    const result = await new ActivityLogPartitionsRepo(env).ensurePartitions({ now });

    expect(result).toMatchObject({
      isSuccess: true,
      createdPartitions: [name],
      missingMonths: [],
      hasDefaultRows: false,
    });
    expect((await getPartitions()).get(name)).toBe(partitionBound(target));
    expect(await countIndexes(name)).toBe(await countIndexes(sibling));
    expect(await countRows(DEFAULT_PARTITION)).toBe(0);

    const { rows } = await ownerDb.execute<{ canSelect: boolean; canInsert: boolean }>(sql`
      select has_table_privilege('diletta_app', ${name}, 'SELECT') as "canSelect",
        has_table_privilege('diletta_app', ${name}, 'INSERT') as "canInsert"
    `);
    expect(rows[0]).toEqual({ canSelect: false, canInsert: false });
  });

  it("alerts when a month in the window can't get a partition", async () => {
    vi.mocked(AppLogger.error).mockClear();
    // DEV_NOTE: A window in the past: the function refuses every month, without touching the partition set
    const now = new Date(Date.UTC(2020, 0, 15));

    const result = await new ActivityLogPartitionsRepo(env).ensurePartitions({ now });

    expect(result).toMatchObject({
      isSuccess: false,
      createdPartitions: [],
      missingMonths: ["2020-01", "2020-02", "2020-03", "2020-04"],
      hasDefaultRows: false,
    });
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        category: Schemas.LogCategory.Partition,
        action: Schemas.LogAction.EnsureActivityLogPartitions,
        message: "activity_log months without a partition",
        metadata: { missingMonths: ["2020-01", "2020-02", "2020-03", "2020-04"] },
      }),
    );
  });
});
