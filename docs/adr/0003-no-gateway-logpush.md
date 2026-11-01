# ADR 0003: No Logpush copy of AI Gateway logs

- Status: Accepted
- Date: 2026-11-01
- Task: M6-1 (retention)
- Changes: the architecture diagram's AI Gateway box, "Logpush to own storage" and "R2 lifecycle on Logpush". The M6-1 plan row's "Logpush lifecycle" has nothing left to apply to.

## Context

Gateway logs hold full prompts. The diagram had them exported by Logpush to our own R2 bucket, with a lifecycle rule to expire the copy. Nothing in the repo reads such a copy: the usage backfill (`ModelCallsRepo.backfillPendingUsage`) reads the gateway's own log API, within the hour, and spend and metrics come from `model_calls`.

Companies are promised chat content goes after their retention period, as short as 7 days. A second store of the same prompts is one more place to delete from, and it pays per export.

## Decision

1. No Logpush job and no log bucket. The gateway's own logs are the only copy of a prompt outside the conversation.
2. Those logs are kept 7 days at most (`Schemas.GATEWAY_LOG_RETENTION_DAYS`), by the platform's retention for the log store, not by code. `docs/runbooks/ai-gateway.md` has the check.
3. Collect Logs stays on: the usage backfill needs it.

## Consequences

- No prompt history past 7 days, for debugging or anything else. `model_calls`, `activity_log` and the application logs (no chat text) remain.
- Adding Logpush later needs a new ADR, a dedicated bucket and a lifecycle rule no longer than `GATEWAY_LOG_RETENTION_DAYS`.
- A gateway on Legacy Logs (an account whose first gateway predates 2026-09-24) is capped by log count, not by days, and doesn't meet this until moved or cleared: see the runbook.
