# Observability and alerts

How errors and alerts reach our team (M6-6). Every alert is an **error log**. Workers Logs keeps every log, at every level. Sentry receives the errors, and Sentry alert rules post them to Slack, **#diletta-alerts**. Nothing in the worker talks to Slack.

```
AppLogger.error ──► Workers Logs (every level, JSON)
        └─────────► Sentry (error and fatal only, redacted) ──► alert rule ──► Slack #diletta-alerts
uncaught error in a worker handler ──► withSentry ──► Sentry (scrubbed)
```

## What is sent, and what never is

- **Log records**: the logger's Sentry sink (`providers/logger.ts`) sends every record at error level or above, from every place the backend runs: routes, crons, the queue consumer, both Durable Objects and the knowledge workflow. A record is redacted before it is sent (`redactRecord`, then `APP_REDACT_FIELDS` and LogTape's default fields), so Sentry holds what Workers Logs holds and nothing more. Errors are already reduced by `toLoggableError`: no prompt, no response body, no query values.
- **One Sentry issue per alert**: the fingerprint is the log's category, action and message, plus `metadata.companyId` when there is one. So each company gets its own issue, and its own Slack message.
- **Uncaught errors**: a route that throws is logged by Hono's `onError` (`Middleware` / `HandleUncaughtError`, answered 500). Anything that escapes the worker's fetch, scheduled or queue handler goes through `Sentry.withSentry`. Before it is sent, `scrubSentryEvent` drops the request (its headers carry the widget's JWT), the user, breadcrumbs and extras. A failed query's message becomes its SQL text, and other exception text is redacted. A cron job that throws is logged as `Cron` / `DispatchCron` "Cron job threw".
- **Not wrapped**: the Durable Objects and the workflow don't use Sentry's own instrumentation (see `providers/sentry.ts`). Their errors reach Sentry as log records.
- **Dashboard (`apps/web`)**: `@sentry/tanstackstart-react` on the server and in the browser. `sendDefaultPii: false`, traces at 10%, and Session Replay with every text, input and media masked.
- **Off locally and in tests**: an empty `SENTRY_DSN` sends nothing.

## Set up (once per environment)

1. **Sentry projects**: `diletta-worker` (backend, platform JavaScript / Cloudflare) next to the existing `diletta` (web). Under Project settings › General, set **Auto resolve** to 7 days. An alert that stops firing then closes itself, so its next occurrence (for example a company's budget next month) is a regression and alerts again.
2. **DSN**: `pnpm --filter backend exec wrangler secret put SENTRY_DSN --env staging`, and the same with `--env production`, using the `diletta-worker` DSN. `SENTRY_ENVIRONMENT` is already a var in `wrangler.jsonc` (`staging` / `production`). Leave `SENTRY_DSN` empty in `.dev.vars`.
3. **Slack**: Settings › Integrations › Slack, connect the workspace, then invite the Sentry app to #diletta-alerts.
4. **Alert rules** (Alerts › Create alert › Issues), on both projects:

   | Rule                        | When                                                                    | If                                        | Then                  | Action interval |
   | --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- | --------------------- | --------------- |
   | `New error — production`    | A new issue is created, or an issue changes from resolved to unresolved | environment = `production`                | Slack #diletta-alerts | 5 minutes       |
   | `New error — staging`       | the same                                                                | environment = `staging`                   | Slack #diletta-alerts | 30 minutes      |
   | `Still firing — production` | The issue is seen more than 10 times in 1 hour                          | environment = `production`, level = error | Slack #diletta-alerts | 1 hour          |

5. **Check it**: on staging, run `pnpm --filter backend exec wrangler tail --env staging` and trigger an error, for example a bad cron expression in a local `scheduled` test call. Make sure the Slack message arrives.

## Alerts and what to do

Workers Logs (dashboard › Workers › `diletta-worker` › Logs) filters by `category` and `action`. Sentry shows the same fields as tags.

| Message (category / action)                                                                                                          | Means                                                                                                                                 | First step                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Outbox events waiting too long to publish" (`Relay` / `CheckEventOutboxHealth`)                                                     | Right after the 15-minute sweep, a Pending row is still older than `OUTBOX_LAG_ALERT_MS` (5 min)                                      | Look for "Queue unavailable, events left pending" around it: a Queue outage clears itself, and the sweep keeps retrying. A DB failure shows as a `DAL` error. A backlog bigger than `OUTBOX_SWEEP_MAX_BATCHES × OUTBOX_BATCH_SIZE` per tick drains over a few ticks |
| "Outbox events failed and need a manual retry" (`Relay` / `CheckEventOutboxHealth`)                                                  | Rows in Failed: the Queue rejected them `OUTBOX_MAX_ATTEMPTS` times, and they are never retried automatically                         | Read `event_outbox.last_error` for those rows. Fix the cause, then set them back to Pending (`status = 1, attempts = 0`) as the owner, and the next sweep sends them. Repeats every tick until no Failed row is left                                                |
| "Events rejected by the Queue", "Events failed after 5 attempts", "Queue unavailable, events left pending" (`Relay` / `RelayEvents`) | One relay's send failed                                                                                                               | As above                                                                                                                                                                                                                                                            |
| "Company budget 50% / 80% / 100% used" (`Budget` / `ReachBudgetThreshold`)                                                           | The company's settled spend this month reached that share of `spending_budget`, once per company per month                            | Tell the company's contact before they run out. Admins see their use on Settings › Budget; there are no admin notifications in v1                                                                                                                                   |
| "Company budget used up; model calls refused" (`Budget` / `ExhaustCompanyBudget`)                                                    | A model call was refused for the company's budget: its users see "Temporarily unavailable"                                            | Same. The admin raises the budget on Settings › Budget, and BudgetDO picks it up within `BUDGET_REFRESH_MS` (`docs/runbooks/budget.md`)                                                                                                                             |
| "Budget refused" with refusal `Unavailable` (`Budget`)                                                                               | BudgetDO couldn't count (Neon unreachable): every call is refused, fail closed                                                        | Check Neon and Hyperdrive. It clears on the next successful load                                                                                                                                                                                                    |
| "Unhandled error in a route" (`Middleware` / `HandleUncaughtError`)                                                                  | A route threw instead of answering                                                                                                    | A bug: the error and path are in the issue                                                                                                                                                                                                                          |
| "Cron job threw" (`Cron` / `DispatchCron`)                                                                                           | A cron job threw instead of logging its own failure                                                                                   | A bug. The other jobs in the tick still ran, and the job runs again on its next schedule                                                                                                                                                                            |
| Nightly suite, chatbot health, partitions, platform eval cases, key rotation, retention purge                                        | See their runbooks: `nightly-suite.md`, `health.md`, `activity-log-partitions.md`, `nightly-suite.md` › Platform cases, `security.md` |                                                                                                                                                                                                                                                                     |

Step-by-step playbooks for a key failure, a change that needs a person, relay failures and a config rollback: `docs/runbooks/incidents.md`.

Any other error log also opens a Sentry issue and posts once. The `category` and `action` tags name the code path.

Per-user and rate refusals (`UserDailyCost`, `UserMessageRate`, conversation and turn caps) are limits doing their job. They are warnings, never alerts.

## Outbox lag

The queue consumer logs each event with `lagMs`, the time from its outbox row to consumption (`Queue` / `ConsumeEvent`, "Event received"). Filter Workers Logs on it to see the lag over time. The load test's target is p95 ≤ 60 s (`docs/runbooks/load.md`). A message sent before M6-6 has `lagMs: null`.
