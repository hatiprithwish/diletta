# ADR 0007: Eval runs start from the dashboard on a hosted runner

- Status: Accepted
- Date: 2026-11-05
- Task: M7-9 (hosted eval runner)
- Changes: the locked M5-4 decision "a gate run is started by `pnpm evals:run --trigger gate` (us or CI); no hosted runner, no Run button" (CLAUDE.md › Runtime › Publish gate, `docs/runbooks/evals.md`). A company admin may now start a gate run or a manual run from the dashboard, and the run executes on a Cloudflare Python Workflow.

## Context

The eval harness (`evals/diletta_evals`, M5-2) is a Python client of `/eval/*`. It signs the eval JWT with the platform's private key, signs the host test user in to get the host token, runs every case k times, grades, records, resets and finishes. Today it runs only from a laptop (`pnpm evals:run`) or GitHub Actions (the nightly suite). That means a company admin who sends a version to testing can't move it to Ready themselves: someone on our team has to run the gate. With eRegister (M7-4) and every company after it, the gate becomes a queue on us.

Two things kept the harness off the platform. The Worker runtime couldn't run Python, and a run lasts minutes (cases × k × one turn of up to 3 minutes). Both are gone: Cloudflare Workflows run Python (`python_workflows`), a step has no wall-clock limit (CPU only, and a step waiting on a call uses none), and Python and TypeScript Workers call each other over service binding RPC. The harness can run as it is, on a Workflow, with each attempt its own durable step.

What the runner needs that the backend doesn't hold today is the host test user's login (the test host's admin secret, eRegister's Firebase email and password). The harness reads it from `evals/.env`; a hosted runner needs it per company.

## Decision

1. **A Python Worker runs the harness.** `apps/eval-runner` is a Python Worker with one Workflow (`EvalRunWorkflow`). Its steps are the harness's own (`diletta_evals`, made async; the CLI keeps working through `asyncio.run`): start the run, one step per case attempt, reset, finish. The CLI stays for local runs, and the nightly suite stays on GitHub Actions.
2. **The dashboard starts a run.** `POST /dashboard/eval-runs` (`authorizeCompany(EvalRunStart)`, a new action company admins hold, and so an operator acting in the company, ADR 0006) takes a chatbot config and a trigger: Gate (the config must be Testing, k = `EVAL_GATE_MIN_K`) or Manual (any version). It refuses while that config already has a Queued or Running run, inserts a Queued `eval_runs` row with `started_by`, records an audit row in the same transaction, then creates the Workflow instance over the service binding. The harness's `/eval/runs` also accepts that Queued run by its public id and starts it, so the Tests page shows the run from the moment the button is pressed.
3. **The host test login is a company secret.** It is stored in `company_secrets` as a new type, `EvalHostLogin`, on a Staging connection only, encrypted under the company key through `CompanyKeyProvider` like every other secret (so company key rotation re-encrypts it and erasure of the company shreds it). Operators set and clear it on the connection (audited). Its body is a Zod union by host kind in `packages/schemas`.
4. **The one plaintext exception.** The runner gets that login, decrypted, from the backend's `EvalRunnerEntrypoint.getRunLogin(runPublicId)`, a service binding RPC method. That method is callable only over the binding (it is not a route), answers only for a run that is Queued or Running, and only that run's connection's login. This is the only place a decrypted company secret leaves the backend's process. It never goes in a route response, a log, an event, a Workflow input (instance params are persisted) or a step's return value (step results are persisted): the runner holds it, and the host token it signs in with, in isolate memory only, and fetches it again in any step that needs it.
5. **An attempt runs once.** An attempt step has no retries, as the CLI sends `/attempts` once. If a step is cut off and Workflows replays it, `/attempts` answers 409 `Duplicate`, and the attempt is recorded as failed ("the attempt was interrupted"), never run twice. Steps that are safe to repeat (readbacks, the judge, results, the reset) keep the client's own retries.
6. **The platform eval key is one runner secret.** `EVAL_JWT_PRIVATE_KEY` is a Worker secret on `apps/eval-runner` per env, the same key the CLI uses; the backend still holds only the public JWKS. Every `/eval/*` check stays as it is: Staging connections only, the company and connection from the token.

## Consequences

- An admin can take a version from Testing to Ready without us. A gate run spends the company's model key, as it does from the CLI; the dashboard says so before it starts (cases × k).
- A new tenant secret type and a new plaintext path. The path is narrow (one RPC method, one run's login, worker to worker) and the login is a staging test user's, never a real user's. The CLAUDE.md rule "a plaintext secret never in a route response" is unchanged: this is not a route.
- `apps/eval-runner` is a second runtime (Python on Pyodide) to deploy and keep pinned. Its Python packages come through its own `pyproject.toml` + `uv.lock`, asked first like any package.
- The harness becomes async. The CLI, the nightly suite and the load test behave as before.
- A run that a Workflow can't finish (the runner down, an unhandled error) still ends: the Workflow's last step finishes the run Failed, as the CLI does today, and a run left Queued or Running is visible on the Tests page.

## Amendment: chained instances (2026-11-06)

The first production run stopped at its 10th attempt with "Too many subrequests". A Workflow runs its steps inside one invocation, and a Workers Free invocation may make only 50 subrequests to the internet (1,000 to Cloudflare services). An attempt made about five (the backend over its public URL, the host's sign-in and read-backs), so any run past ~9 attempts failed, and its reset and finish failed with it. Workers Paid lifts the limit, but the runner has to work on Free.

1. **One Workflow instance per link.** A run is a chain of instances of the same `EvalRunWorkflow`: `start`, one per attempt, then `end` (reset and finish). Each is a fresh invocation with its own budget, so the run's size never matters. Each link runs its step, then creates the next instance in a `next` step. The backend still creates the first (id = the run's public id); the others are named by where they are (`<run>-c<case>-a<attempt>`, `<run>-end`), so a repeated `next` finds the instance it created instead of running a step twice. A link's params carry the two public ids, the case set the backend handed out, k, its position and a stop: never a sign-in or a token (point 4 stands). The steps are `diletta_evals.hosted`, the chain's order is `hosted.after_start` / `after_attempt`.
2. **Backend calls go over the binding.** `EvalRunnerEntrypoint.fetch` serves `/eval/runs*` from the same Hono app (any other path is 404), and the runner's `EvalApiClient` sends through it (`binding_transport.py`). Those calls count against the 1,000 internal budget; only the host's own calls (the test user's sign-in, read-backs) use the internet one.
3. **A broken chain still ends.** A `next` that never ran leaves the run Running. The next Run press on that version fails a Running run whose row hasn't moved for `EVAL_RUN_RUNNING_STALE_MINUTES` (30; every model call's cost moves `updated_at`) as `RunnerUnavailable`, as it already did for a run left Queued.
4. **A run that couldn't start says why.** `failQueuedRun` takes the stop's failure (a failed host sign-in is `HostUnavailable`, a refused eval token `HarnessError`), not always `RunnerUnavailable`; the stop's message is logged by the runner (Workers Logs) and kept in the instance's output.

Cost on Free: about two Workflow steps per attempt (Free allows 3,000 steps a day), so a gate run of 9 cases × 3 is about 60 steps.

## Amendment: resume, and run the failed cases (2026-11-06)

A run that stops on the way (the judge or host down, a runner fault) had to be run again from the first case, spending the company's model key on attempts that already had a result. Two changes cut that.

1. **Resume a Failed run.** `POST /dashboard/eval-runs/:publicId/resume` (`EvalRunStart`) reopens a run that `Schemas.isEvalRunResumable` (Failed, started from the dashboard, holding its case set): Failed → Queued in one `withTenant` (the version locked, the same one-run-per-version and test sign-in checks as a new run, audited `RunResumed`), its results, case set and `created_at` kept, its verdict, failure, reset and finish cleared, `resumed_count` one up. The runner starts its chain again as `<run>-r<n>`; `/eval/runs {runId}` hands back the run's own set and `doneAttempts`, the attempts that already have a result, and the chain skips them. Done still means k results for every case of the set and a reset, in one run: a resumed gate is as strict as a fresh one.
2. **An attempt without a result may be sent again in a resumed run.** This changes M5-2's "an attempt runs once". An eval conversation is now unique per (run, case, attempt, **try**), `conversations.eval_try` = the run's `resumed_count` when it started, so the attempt that was cut off gets a new chat in the next try. It is safe because the run was reset before it finished Failed (the host's test data is clean again), and an attempt that has a result is never run again in any try (`/attempts` answers `Duplicate`). Inside one try nothing changes: a replayed step still finds its chat and is recorded as interrupted.
3. **A gate run that stopped isn't a verdict.** This changes M5-4. Only a **Done** gate run moves its version (Ready on a pass, Draft on a fail). A Failed one leaves it Testing, so it can be resumed or run again; the safety rule and `evalRunGateDecision` are unchanged.
4. **Run failed cases.** `POST /dashboard/eval-runs` takes `failedCasesOfRunId` on a Manual run only: the run holds, from the moment it is queued, the cases of that run (same chatbot) that didn't pass every attempt (`Schemas.failedEvalCaseIds`, a case never run included) and are still active. A Gate always runs every case.

The run page shows **Resume** when `runActions.canResume` and **Run failed cases (n)** when `runActions.failedCaseCount` > 0.
