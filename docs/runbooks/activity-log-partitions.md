# activity_log partitions

`activity_log` is partitioned by month on `created_at` (UTC bounds), one table per month named `activity_log_y<YYYY>m<MM>`, plus `activity_log_default`. A row whose month has no partition lands in `activity_log_default`. The default partition should always be empty: once it holds a row for some month, that month's partition can't be created until the row is moved out.

## What keeps the partitions in place

A daily job at 03:00 UTC (`src/crons/ActivityLogPartitionsCron.ts`, picked by `CronScheduleProvider` from the Worker's one every-minute cron trigger) makes sure the current UTC month and the next 3 each have a partition. Partitions from the `*_partition_activity_log` migration run through 2027-12, so the Cron first creates one in 2027-10 (for 2028-01).

The worker connects as `diletta_app`, which can't run DDL ([app-role.md](app-role.md)). It reaches the owner's rights only through two `SECURITY DEFINER` functions from the `*_activity_log_partition_maintenance` migration:

| Function                                       | Does                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_activity_log_partition(p_month_start)` | Creates the partition for one UTC month, from the current month up to 12 months ahead. Does nothing if it exists. Waits at most 5s for its lock on `activity_log`. |
| `activity_log_default_has_rows()`              | Says whether `activity_log_default` holds any row. Returns no row data.                                                                                            |

Both are owned by the owner role, run with a fixed `search_path`, and can be executed by `diletta_app` only.

## Alerts

The Cron logs an error (category `Partition`, action `EnsureActivityLogPartitions`) in these cases. Each run retries, so a one-off failure for a future month clears itself the next day.

| Message                                              | Meaning                                                                  | Do                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `activity_log months without a partition`            | `metadata.missingMonths` (YYYY-MM) still have no partition after the run | Find the `CreateActivityLogPartition` error logged just before it and check its SQLSTATE (below).                                  |
| `activity_log default partition has rows`            | Rows landed in `activity_log_default`                                    | [Move them out](#move-rows-out-of-the-default-partition).                                                                          |
| `Could not check the activity_log default partition` | The check itself failed (DB unreachable, function missing)               | Check the `GetActivityLogDefaultHasRows` error. If the function is missing, run `pnpm --filter backend db:migrate` on that branch. |

SQLSTATE of a failed create:

- `55P03` (lock timeout): a long query held `activity_log`. The next run retries; if it keeps failing, look for long-running transactions on the branch.
- `23514` (check violation): rows for that month are already in the default partition. Move them out (below).
- `42P07` (duplicate table): a table with the partition's name exists but isn't attached to `activity_log`. Find out why before attaching or dropping it.
- `42883` (undefined function): the migration hasn't run on that branch.

## Create a partition by hand

Run as the owner role (Neon SQL editor or `psql "$DATABASE_URL"`) on the right branch. For a month within the function's range:

```sql
SELECT * FROM create_activity_log_partition('2028-01-01 00:00:00+00');
```

For any other month, write the DDL with UTC bounds:

```sql
CREATE TABLE activity_log_y2028m01 PARTITION OF activity_log
  FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2028-02-01 00:00:00+00');
```

Never grant a partition to `diletta_app`. The app reaches partitions only through `activity_log`, where the RLS policies apply.

## Move rows out of the default partition

Run as the owner, one month at a time, in one transaction. The owner has `BYPASSRLS`, so it sees every company's rows. The transaction locks `activity_log` until it commits, so writes wait for it: keep it short.

```sql
BEGIN;
CREATE TEMP TABLE moved_rows ON COMMIT DROP AS
  SELECT * FROM activity_log_default
  WHERE created_at >= '2028-01-01 00:00:00+00' AND created_at < '2028-02-01 00:00:00+00';
DELETE FROM activity_log_default
  WHERE created_at >= '2028-01-01 00:00:00+00' AND created_at < '2028-02-01 00:00:00+00';
CREATE TABLE activity_log_y2028m01 PARTITION OF activity_log
  FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2028-02-01 00:00:00+00');
INSERT INTO activity_log OVERRIDING SYSTEM VALUE SELECT * FROM moved_rows;
COMMIT;
```

Then check that `SELECT activity_log_default_has_rows();` returns `false`.
