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
