# Nightly platform suite

Every night the eval harness tests our own test company's live chatbot on the staging test host (M5-5). It catches a platform change that breaks the chatbots before a customer's gate or a customer's users do. The run is an ordinary eval run with trigger Nightly (`docs/runbooks/evals.md`), so the Tests page shows it as "Nightly platform suite".

## What it runs

- **Platform cases**: every active platform case (`company_id` null). They are defined in code (`packages/schemas/src/evalCases/PlatformEvalCases.ts`) and every company's gate runs them too, so they name no tool and no record. The safety ones block publishing when they fail (M5-4).
- **The test company's own cases**: the cases on the test host's tools (`packages/schemas/src/testHost/TestHostEvalCases.ts`): a create and an update that must read back as asked, and a lookup that must change nothing. They belong to the test company's default chatbot only.

Each case runs k = 3 attempts (pass^k), on the chatbot's **published** config at the moment the run starts.

## How it runs

`.github/workflows/nightly-evals.yml`, at 02:00 UTC, and by hand from the Actions tab (Run workflow, optional `k`). It uses the GitHub `staging` environment:

| Setting                  | Where                                 | What                                                      |
| ------------------------ | ------------------------------------- | --------------------------------------------------------- |
| `EVAL_JWT_PRIVATE_KEY`   | environment secret                    | The harness's private eval key (`docs/runbooks/evals.md`) |
| `TEST_HOST_ADMIN_SECRET` | environment secret                    | The staging test host's admin secret                      |
| `NIGHTLY_CHATBOT_ID`     | environment variable                  | The test company's default chatbot's public id            |
| company, connection, API | in the workflow (public ids and URLs) | Diletta Test Company, its test host connection, staging   |

The job runs `python -m diletta_evals run --chatbot $NIGHTLY_CHATBOT_ID --trigger nightly --k 3`. The backend picks the chatbot's published config (`POST /eval/runs` with `chatbotId`); a chatbot with none is 409 `NoPublishedConfig` and the job exits 2. A run by chatbot is never a gate run, and it never moves a version.

## Alerts

| Alert                                                     | From                                                        | Means                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The job fails, exit 1                                     | GitHub Actions                                              | The run finished and failed: a regression. Open the run on the Tests page                                                               |
| The job fails, exit 2                                     | GitHub Actions                                              | It couldn't run: a setting, the backend, the host, or the judge. The log says which                                                     |
| "The nightly platform suite failed" / "didn't finish"     | backend error log (`Eval` / `ReportNightlyEvalRun`)         | A Nightly run finished without passing (any company, any way it was started)                                                            |
| "The nightly platform suite hasn't finished a run lately" | backend error log (`Eval` / `CheckNightlySuite`), 06:00 UTC | No Nightly run of `NIGHTLY_SUITE_COMPANY_ID` reached Done in the last 26 hours: the job didn't run, was cancelled, or every run stopped |

The backend's error logs reach Sentry with M6-6. `NIGHTLY_SUITE_COMPANY_ID` is a `wrangler.jsonc` var, set on staging only; empty means nothing is checked (local and production).

**What to do on a failure:** open the run on the Tests page (Tests › Runs, "Nightly platform suite"), find the failed cases and their grader output and transcripts. A failed platform safety case is the most urgent: it will block every company's next publish. If the change that broke it is in `main`, revert or fix it before the next customer gate.

## Platform cases

Platform cases reach each database through the worker, not a script: the hourly `PlatformEvalCaseSync` cron (`PlatformEvalCasesRepo.sync`) writes `PLATFORM_EVAL_CASES` to `eval_cases`, matched by `platform_key`. So a merged change reaches staging, then production, within an hour of each deploy.

- **Add a case**: add an entry with a new `platformKey` (lowercase words joined by `.` or `_`). `PlatformEvalCases.test.ts` checks the whole list loads; a list with one bad case is never written.
- **Change a case**: edit it in place, keeping its key. The next sync rewrites the row (the case keeps its public id and results).
- **Remove a case**: delete the entry; the next sync turns the row off. A **safety** case can't be turned off (the database refuses it): the sync keeps it active and logs "Platform safety cases no longer in code are still active" every hour until a migration retires it.
- **Expect the gate to move**: a new or changed safety case makes every Ready version's gate outdated (publish answers `GateOutdated`), so each company sends its version to testing again. Say so in the PR.

A platform case's text is never sent to a company (the Tests page shows its name only).

## Setting up the test company

Once per environment that runs the suite (staging):

1. The company exists (operator API) with its test host connection: `pnpm --filter test-host seed --company <publicId>` (`docs/runbooks/test-host.md`).
2. Give it an active default chatbot and a model key (Settings › Bots, Settings › Model keys), then run the seed again: it adds the test company's cases to that chatbot.
3. Publish a config that pins the test host's tools (the seed prints the pins) through the gate (Settings › Bots, `docs/runbooks/bots.md`).
4. Set `NIGHTLY_CHATBOT_ID` in the GitHub `staging` environment to that chatbot's public id, and the two secrets above.
5. Run the workflow by hand once and check the run on the Tests page.

## Troubleshooting

| Symptom                                               | Likely cause                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Job exits 2 with "Missing in the staging environment" | A secret or `NIGHTLY_CHATBOT_ID` isn't set on the `staging` environment                  |
| 409 `NoPublishedConfig`                               | The test company's chatbot has no published config: publish one through the gate         |
| 404 on start                                          | `NIGHTLY_CHATBOT_ID` isn't the test company's chatbot                                    |
| Every attempt "The attempt didn't run"                | The test company has no model key, or its budget is used up                              |
| Missed-run alert while the job is green               | The job ran against another company, or `NIGHTLY_SUITE_COMPANY_ID` names another company |
| The sync alert about safety cases every hour          | A platform safety case was removed from code: retire it with a migration, or put it back |
