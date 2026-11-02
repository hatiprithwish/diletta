# ADR 0004: The Worker's cron trigger runs every 15 minutes

- Status: Accepted
- Date: 2026-11-02
- Task: ops (not a plan row)
- Changes: the locked Crons decision in CLAUDE.md and `feature-rules.md` › Crons: the one trigger (`Constants.CRON_TRIGGER`, = `wrangler.jsonc` `triggers.crons`) goes from `* * * * *` to `*/15 * * * *`.

## Context

The trigger ran every minute for three jobs: the outbox sweep, the `model_calls` usage backfill and the change request values purge. The hourly and daily jobs only need the tick at `CRON_HOURLY_MINUTE`. Every tick is an invocation and a log event on both environments, ~1,440 a day each, mostly empty sweeps.

## Decision

1. `Constants.CRON_TRIGGER` and `wrangler.jsonc` `triggers.crons` are `*/15 * * * *` (minutes 0, 15, 30, 45 UTC). Still one trigger per Worker.
2. `CRON_HOURLY_MINUTE` stays 0: the hourly and daily jobs still run on the minute-0 tick, unchanged.
3. The three former per-minute jobs now run every 15 minutes. Their ages and windows are not changed.

## Consequences

- Outbox sweep: an event the after-commit relay missed is published up to ~15 min late (was ~1). The relay itself is unchanged and still the normal path. A run still sends at most 10 batches, so a backlog drains 15× slower.
- Usage backfill: a Pending row is looked up about 4 times before `MODEL_CALL_BACKFILL_MAX_AGE_MS` (1 h) turns it Unknown, instead of up to 60. A Gateway log that appears late has fewer chances to be read.
- Change request purge: encrypted values are emptied up to ~15 min after the undo window ends (was ~1), and a purge backlog drains 15× slower.
- Every job is still safe to miss once, now a 15-minute gap.
- A cadence other than `*/15` needs the minute-0 tick to stay in it, or `CRON_HOURLY_MINUTE` changed with it.
