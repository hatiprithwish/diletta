# Evals

The eval harness (`evals/`, M5-2) tests a chatbot config on a company's **staging** connection before it goes live. It starts a run of one config, runs each of the chatbot's active cases and every active platform case `k` times (pass^k), grades each attempt, records it, puts the staging data back, and finishes the run. The Tests page (`docs/runbooks/tests.md`) shows the result.

The harness drives the backend's `/eval/*` API. The backend runs each attempt in a real Conversation DO, on the config under test, against the staging host. Nothing an eval does shows on the dashboard's Conversations or Changes pages or in Insights.

A case's rubric is graded by a pinned LLM judge on the company's key (M5-3), and every attempt that ran keeps its transcript in R2 for the Tests page (see [The judge and transcripts](#the-judge-and-transcripts)).

## How a run works

1. **Sign in to the host.** The harness gets the host test user's bearer token from the host's own login (the test host: an admin-minted token in a fresh workspace). It sends that token with every call that reaches the host. The backend keeps it in memory only.
2. **Start the run.** `POST /eval/runs` with the config's public id and `k`. The backend creates the run (Running) and answers its cases, already upgraded to the current shapes. If any active case can't be read, nothing is created (400 `Invalid`): the gate never passes on a case it skipped. The run keeps the cases it handed out (its case set) and the staging connection the token named. Every later step must use a token for that connection (another one is 404), and only cases of the set can be run or recorded (a case added or turned off after the start is 404).
3. **Run each attempt.** For every case and attempt, the harness fills `{case.tag}` with a new token and calls `POST /eval/runs/:runId/attempts`. The backend starts a new conversation pinned to the run's config and runs it in one turn:
   - every tool the config pins runs against the token's staging connection, whatever connection the tool version names;
   - a write the approval rules say needs a user's approval is approved by the eval on the user's behalf, then committed and verified in the turn (a Blocked rule still blocks). Each tool call says whether it needed approval (`wasApprovalRequired`), so a case can check the policy too;
   - its model calls count toward the company's budget, never toward a user's limits (messages per minute, daily cost);
   - its model calls are the run's (they count toward the company's budget, and each adds its cost to the run's `cost_usd`).
4. **Grade it.** The harness checks the attempt (`evals/diletta_evals/graders.py`): forbidden tools never ran, each expected call was made, each readback reads back (`POST /eval/runs/:runId/readbacks`, the same request live verification sends), the reply rules hold, and, for a case with a rubric, the judge agrees (`POST /eval/runs/:runId/judge`). It records the attempt with its grader output (`POST /eval/runs/:runId/results`); the backend stores the attempt's transcript with it.
5. **Reset.** `POST /eval/runs/:runId/reset` sends the connection's `reset_op` once, after the last attempt. Attempts aren't reset between them: with `k` > 1, attempt 2 sees attempt 1's records. That's why every case must be state-independent, naming its own records with `{case.tag}` (a new tag per attempt). A reset that went through (or a connection with no `reset_op`) marks the run reset; Done needs it.
6. **Finish.** `POST /eval/runs/:runId/finish`. Done when every case of the set has all `k` results (and the reset worked), else Failed ("Didn't finish" on the Tests page). Asking for Done while a case of the set is short is 409 `Incomplete`. The run passes (`Schemas.evalRunGateDecision`, M5-4) when it is Done, at least `EVAL_GATE_PASS_PERCENT` (95%) of the set passed all `k` attempts, and every safety case of the set passed all `k` (one that never ran counts as failed): one failed safety case fails the run, however many others passed. The answer says how many safety cases failed (`failedSafetyCaseCount`), and the CLI prints it.
7. **The gate (M5-4).** A run with `--trigger gate` is the publish gate of a version an admin sent to testing (Settings › Bots, `docs/runbooks/bots.md`); a Gate run of any other version is 409 `NotTesting`, and one with `--k` below `EVAL_GATE_MIN_K` (3) is 400 `Invalid` (the CLI exits 2 on either). Its finish moves the version in the same transaction: passed → Ready (`approved_by_run_id`), else back to Draft. A version taken back to draft (or sent again) after the run started isn't moved by it. Manual and Nightly runs never move a version.

**Cost.** `cost_usd` grows as the run's model calls are recorded. A call cut off before the provider reported its usage is Pending until the per-minute backfill reads its AI Gateway log, and then adds its real cost. So the cost shown at the finish can still rise for a few minutes.

**Trust.** The harness is platform code that holds the platform key. The backend doesn't compare an attempt's messages with the stored case (the harness fills `{case.tag}` in them), and the grading is the harness's own. What the backend does enforce is the run's case set, its connection, `k`, and that a passing result has no grader error.

An eval conversation is the harness's only. The widget can't resume it, even for the same host user, and a model-key failure in it marks the key Invalid without opening a Quality issue.

An attempt the backend couldn't start (the chatbot is paused, there's no model key, a budget said no: `failure` `ChatbotUnavailable` or `BudgetRefused`) is recorded as failed with the reason, and the run goes on. Anything else that stops the run (a backend `ServerError`, the backend or the host unreachable, a host login that fails, a judge that couldn't give a verdict, a harness error) ends it Failed, after the reset, and the CLI exits 2. The run keeps why (`failure`, shown on the Tests page), from the error that stopped it, else the one that failed its reset:

| `failure`        | When                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| JudgeUnavailable | The judge gave no verdict                                                                           |
| HostUnavailable  | The host login failed, or the host refused the reset (`HostFailed`)                                 |
| ServerError      | The backend answered a 5xx or couldn't be reached                                                   |
| HarnessError     | Anything else: a refusal the harness got (4xx), a harness bug, an answer it couldn't read, a cancel |

Each attempt runs once: the harness never retries `/attempts` (a repeat is 409 `Duplicate`). Readbacks, results and the reset are retried on a dropped connection or a 5xx.

## The judge and transcripts

**The judge.** A case with a rubric is graded by an LLM judge, after the deterministic checks, only when its verdict can still decide the attempt: the chatbot's turn completed and every other check passed. An attempt the other checks already failed isn't judged (the call is billed and couldn't change it), so it shows no judge check. The harness sends the attempt's conversation and the rubric (`{case.tag}` filled) to `POST /eval/runs/:runId/judge`; the backend does the rest:

- it reads the attempt from its Conversation DO (the harness never sends one), once the DO is idle: a commit or verify retry still running is waited for, up to 30 s. An idle eval conversation never changes again, so the judge and the stored transcript see the same attempt;
- the judge reads its own view of it: every message and tool call (`search_help_docs` too) with how it ended, never args. It is held to about 30k tokens (`EVAL_JUDGE_TRANSCRIPT_MAX_CHARS`) so it fits every pinned model: the chatbot's last reply is always kept whole, then the newest earlier entries that fit, with a note of how many were left out;
- the judge model is pinned in `packages/schemas` (`EVAL_JUDGE_MODELS`), two per provider (a primary and an alternate), for the provider of the config's default tier (the company has a key for it). The judge is the primary, unless a tier of the config names it: then the alternate, so a model never grades its own replies (`pickEvalJudgeModel`). The config under test never picks its judge;
- the call goes through the model router on the company's key, like the chatbot's: the company budget holds it, its cost is the run's (`cost_usd`) and it is a `model_calls` row with `task_type` `eval.judge` (Usage shows it under test runs);
- the prompt is versioned (`EVAL_JUDGE_PROMPT_VERSION`): the check's detail names the model and prompt version that graded it, e.g. "The reply never gives the date. (judge claude-sonnet-5-5, prompt v1)".

To change the judge, edit `EVAL_JUDGE_MODELS` (both models must be in `MODEL_PRICES` and differ; `EvalHarness.test.ts` checks it) or the prompt in `apps/backend/src/providers/evalJudge.ts` and bump `EVAL_JUDGE_PROMPT_VERSION`. Expect a run's results to move when you do: rerun the gate.

**When the judge can't be reached** (the provider or AI Gateway down, the company's key refused, the budget said no, or no usable answer after `EVAL_JUDGE_MAX_TRIES`), `/judge` answers 503 `JudgeUnavailable`. The judge never makes up a verdict, and the harness never retries it (the backend already did). It records that attempt failed ("The judge couldn't be reached: …"), stops, resets, and ends the run Failed with `failure` JudgeUnavailable. The CLI exits 2 and prints the reason; the Tests page shows "The judge couldn't be reached" under the run's Didn't finish. A key the provider refused is also marked Invalid (Settings › Model keys), with no Quality issue.

**Transcripts.** When the harness records an attempt that ran, the backend builds its transcript (the case's messages, the chatbot's replies, and each call of a tool the config pins with its version, how it ended and its change's summary; never args or values; `search_help_docs` calls aren't listed, transcript v1 needs a tool version) and stores it in R2 as a `files` row of owner `eval_result`, linked from the result. The Tests page opens it with View transcript. An attempt that never started has none.

- A repeated `/results` for an attempt that already has its result is 409 `Duplicate` straight away, before anything is read or stored (the harness reads it as "the first one landed").
- The `files` row is written first, pending its owner, then the R2 object, then the result's transaction attaches the row. If that transaction refused or rolled back, the object and row are deleted. If its outcome is unknown (the connection dropped at the commit), nothing is touched: either it committed (the harness's retry gets `Duplicate`) or the row is still pending.
- The hourly `EvalTranscriptSweep` cron removes transcript rows still pending after an hour, and their objects. A row a result points at is never pending, so it is never swept.
- A transcript that can't be read or stored fails the `/results` call with a 5xx, and the harness retries it; no result is written until it is.

## The eval JWT

`/eval/*` takes only a platform-signed eval JWT, as `Authorization: Bearer`. The harness signs a fresh one for every request.

| Claim / header | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| `alg` / `kid`  | `ES256`, a key listed in the worker's `EVAL_JWT_PUBLIC_JWKS`       |
| `iss` / `aud`  | `diletta-eval-harness` / `diletta-eval`                            |
| `iat` / `exp`  | at most 5 minutes apart                                            |
| `company`      | the company's public id                                            |
| `connection`   | the public id of the company's **staging** connection              |
| `sub`          | the host test user (also the user every eval conversation runs as) |

What the backend answers:

- **401**: no token, a bad signature, an unknown `kid`, a wrong `iss` / `aud`, expired, or a lifetime over 5 minutes.
- **403**: the company or connection doesn't exist or isn't active, or the connection is a **production** one. An eval never drives a production host.
- **404 / 409**: the run isn't this company's, or it isn't Running any more.

### Setting up the keys

1. Generate a key pair:

   ```bash
   uv run --project evals python -m diletta_evals keygen --kid eval-2026-10
   ```

   It prints the private JWK (for the harness) and the public JWKS (for the worker).

2. Put the public JWKS on the worker, for each env that runs evals:

   ```bash
   pnpm --filter backend exec wrangler secret put EVAL_JWT_PUBLIC_JWKS --env staging
   pnpm --filter backend exec wrangler secret put EVAL_JWT_PUBLIC_JWKS --env production
   ```

   Locally, put it in `apps/backend/.dev.vars`. Production needs it too: eRegister's staging connection lives in the production database (M7-1).

3. Keep the private JWK in the team vault. The harness reads it from `EVAL_JWT_PRIVATE_KEY`. It is never committed.

**Rotating:** generate a new key with a new `kid`, put a JWKS that lists both keys on the worker, switch the harness to the new private key, then remove the old key from the JWKS.

## The connection's reset op

`company_connections.reset_op` is one host call with no placeholders (`ZConnectionResetOp`: `{method, path, query?, bodyMap?}`, the path relative to the connection's `base_url`). Only a staging connection can have one. The harness sends it once after the run, as the host test user. A connection without one is fine when every case is state-independent; the reset then answers `isReset: false`.

- **Test host:** the seed sets it to POST `/_reset` (`Schemas.TEST_HOST_RESET_OP`).
- **eRegister:** set with their staging reset API (M7-1), through `CompanyConnectionsRepo.updateCompanyConnection` (`resetOp`; `null` clears it).

## Running it

Settings come from the environment:

| Variable                 | What                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `DILETTA_API_URL`        | The backend, e.g. `https://diletta-worker-staging.hatiprithwish.workers.dev` |
| `EVAL_JWT_PRIVATE_KEY`   | The private JWK from `keygen` (vault)                                        |
| `DILETTA_COMPANY_ID`     | The company's public id                                                      |
| `DILETTA_CONNECTION_ID`  | Its staging connection's public id                                           |
| `EVAL_HOST_USER`         | The host test user                                                           |
| `EVAL_HOST_KIND`         | How to sign in to the host: `test_host` (default)                            |
| `TEST_HOST_ISSUER`       | `test_host` only: the test host, e.g. `Schemas.TEST_HOST_STAGING_ISSUER`     |
| `TEST_HOST_ADMIN_SECRET` | `test_host` only: the test host's admin secret (vault)                       |

```bash
pnpm evals:run --config <chatbotConfigPublicId> --k 3   # = uv run --project evals --env-file evals/.env python -m diletta_evals run
```

- `--trigger manual|gate|nightly` (default `manual`). `gate` runs the publish gate of a version sent to testing, and its finish moves the version (step 7); the nightly suite (M5-5) starts runs the same way.
- Exit code: 0 the run passed, 1 it failed, 2 it couldn't run (a setting, the backend or the host).
- It prints each attempt (PASS / FAIL and why) and the run's result and cost. The details are on the Tests page.

**On the test host:** seed the test company first (`docs/runbooks/test-host.md`). Its config needs the test host's tools pinned and the company a model key. Each run signs in to a fresh workspace and loads the seed records into it before the first attempt.

**On another host:** add a login for it under `evals/diletta_evals/hosts/` (a `HostLogin`: `prepare()` before the run, `host_token()` per call) and an `EVAL_HOST_KIND` value. eRegister's arrives with its connection (M7-1).

## Changing the API

The request and answer shapes are Zod schemas in `packages/schemas/src/evalHarness/`, exported to `evals/schemas/eval-api.schema.json`, with Python types generated in `evals/diletta_evals/types/eval_api.py`. The constants no message carries (the eval JWT's `iss` / `aud` / lifetime, the headers, the test host's token lifetime) are `ZEvalHarnessConstants`, exported as literals to `eval-constants.schema.json` and read by `diletta_evals/constants.py`; the grader's limits come from the generated grader output type. Nothing is copied into Python by hand. After a change:

```bash
pnpm --filter @app/schemas schema:export && pnpm evals:types && pnpm evals:check
```

and commit the output with the change (pattern rule 3.50).

## Troubleshooting

| Symptom                                                           | Likely cause                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Every call 401                                                    | The worker's `EVAL_JWT_PUBLIC_JWKS` doesn't list the harness key's `kid`, or the clocks are off by more than 30 s                            |
| Every call 500 "Server error" on auth                             | `EVAL_JWT_PUBLIC_JWKS` isn't set on that env, or isn't a JWKS                                                                                |
| 403 on start                                                      | The connection is a production one, disabled, or another company's                                                                           |
| 400 `Invalid` on start                                            | A case can't be read (fix or turn it off), the config doesn't load, the chatbot is paused, or it has no active case                          |
| Attempts fail "The attempt didn't run"                            | The chatbot can't answer: no model key, a budget limit, or the config's model isn't priced                                                   |
| 409 `Incomplete` on a Done finish                                 | A case of the run is short of `k` results, or `/reset` hasn't gone through for the run                                                       |
| 409 `Duplicate` on an attempt                                     | That (case, attempt) already ran in this run: an attempt never runs twice                                                                    |
| 404 on a step of a running run                                    | The token names another staging connection than the run started on, or the case isn't one the run started with                               |
| Readbacks fail "couldn't be read back"                            | The host test user can't read the record, or the host token expired mid-run                                                                  |
| The run ends Failed after a reset error                           | The connection's `reset_op` is wrong or the host refused it; the next run starts from what this one left                                     |
| 503 `JudgeUnavailable` / run ends "The judge couldn't be reached" | The provider or AI Gateway is down, the company's key for the default tier's provider was refused (check Model keys), or the budget is spent |
| `/results` 500 "The transcript couldn't be stored"                | R2 (`FILES_BUCKET`) refused the write, or the attempt's Conversation DO couldn't be reached; the harness retries it                          |
| `/judge` or `/results` 500 "The attempt's turn is still running"  | A commit or verify retry of the attempt ran past 30 s; the harness retries, and the run stops with ServerError if it still runs              |
| Run ends "The test harness stopped the run"                       | The harness hit a bug, couldn't read an answer, was refused a step (4xx) or was cancelled: see the CLI's output                              |
