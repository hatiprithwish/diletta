# Activity rollups

`activity_rollups` holds daily totals for the dashboard (Overview, Usage, Impact): one row per company, chatbot, UTC day and metric, plus a company-wide row (`chatbot_id` null) for each metric. The table is derived and never a source of truth: any (company, day) can be thrown away and rebuilt from the raw tables and `activity_log`.

## How a day is built

`ActivityRollupsRepo.rebuildDay` runs one transaction per (company, day) as `diletta_app` in `withTenant`:

1. Takes an advisory lock on the (company, day), so the hourly run and an operator rebuild of the same day take turns.
2. Reads the day's source groups.
3. Deletes the day's rows.
4. Inserts the fresh ones.

If any step fails, the whole transaction rolls back and the day keeps its previous rows.

A day is the UTC calendar day, `[00:00, 24:00)` on each source row's own timestamp:

| Metric                                                                                   | Counted from                                                                                 | Day by                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `conversations.started`                                                                  | `conversations`                                                                              | `created_at`                                                              |
| `conversations.outcome.<answered\|action_done\|idk\|handoff\|abandoned>`                 | `conversations` with an outcome (closed)                                                     | `created_at`, the start day (closing writes no event, `updated_at` moves) |
| `feedback.up`, `feedback.down`                                                           | `feedback` → reply → conversation's chatbot, current rating                                  | the rating's `created_at`                                                 |
| `change_requests.<verified\|undone\|needs_human\|failed\|rejected\|expired>.tool.<name>` | `activity_log` `change_request.*` events → change request → tool call → tool definition name | the event's `created_at`                                                  |
| `model_calls.<count\|input_tokens\|output_tokens\|cost_usd>.task.<task_type>`            | `model_calls`, every row (failed, Pending and Unknown too, cost as it stands)                | `created_at`                                                              |
| `model_calls.<…>.model.<provider>/<model>`                                               | the same rows, by provider and model                                                         | `created_at`                                                              |

Model calls with no chatbot (eval runs, background jobs) appear only in the company-wide row. Costs are summed exactly, in millionths of a dollar. A day with no activity has no rows.

## When it runs

- **Hourly** (`ActivityRollupsCron`, at `CRON_HOURLY_MINUTE`, picked by `CronScheduleProvider`). Rebuilds yesterday and today for every Active or Paused company. Yesterday is included so that data landing after midnight still reaches its day, such as a Pending cost the gateway backfill fills in or a late change request event. A skipped hour is caught up by the next one.
- **By hand**, for any other range. See below.

Churned companies are skipped by the hourly run. Their rows stay as they are.

## Rebuild a range by hand

Use this after fixing data in a source table, after a long outage, or to fill in days from before rollups existed. You must be signed in as an operator:

```http
POST /operator/companies/<companyPublicId>/rollups/rebuild
Content-Type: application/json

{ "fromDay": "2026-10-01", "toDay": "2026-10-22" }
```

- Both days are included. A request covers at most `ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS` (31) days, and none after today (UTC). Longer ranges go in several requests.
- Each day is rebuilt in its own transaction. `200` means every day was rebuilt. `500` lists the days that failed in `failedDays`; the other days were rebuilt. Repeat the request for the failed days.
- Responses: `403` for a company admin, `404` for an unknown company, `400` for a bad range.

## Alerts

| Log (category `Rollup`)                                                 | Meaning                                     | Do                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RebuildActivityRollupDay` error, `metadata.companyId` / `metadata.day` | One (company, day) failed in the hourly run | Find the DAL error logged just before it (`Get…RollupGroups`, `DeleteActivityRollupDay`, `CreateActivityRollups`). The next hour retries; if the day is already older than yesterday, rebuild it by hand. |
| `RebuildRecentActivityRollups` info with `failedCount > 0`              | Summary of a run with failures              | As above, for each failed day.                                                                                                                                                                            |
| `ListCompanyIdsByStatus` error (category `DAL`)                         | The company list failed: nothing rebuilt    | Check the database connection. The next hour retries.                                                                                                                                                     |

## Known gaps

- Days are UTC. A company in another time zone sees its day boundaries shifted. No company time zone is stored yet.
- A conversation's outcome counts on its start day. Conversations close after `CONVERSATION_IDLE_CLOSE_MS` (30 min) of quiet, so nearly all close before the hourly run stops rebuilding that day (the end of the next UTC day). One kept open longer, by steady activity or an open change request, gets its outcome into the rollup only through a rebuild by hand.
- A rating switched later keeps counting on the day it was first given, with its current value.
