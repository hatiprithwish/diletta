# Load test

The load test (M6-5) is a launch gate: "Load test target met" (Development Plan › Launch readiness). It proves the platform holds up when many chats of one company run at once, and that the budget stays exact under contention. It runs on **staging**, on its own company, against a **stub model** (ADR 0005), so it costs nothing and no provider is called.

## The target

| What                              | Target                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concurrent chats, one company     | **50**, all open together, each sending turns (`LOAD_TEST_TARGET_CONCURRENT_CHATS`)                                                                    |
| Server errors                     | none: no 5xx or unreachable answer from the bootstrap, the upgrade or the token mint                                                                   |
| `BudgetDO` admit, reserve, settle | p95 ≤ **250 ms** each (`LOAD_TEST_BUDGET_OP_P95_MAX_MS`)                                                                                               |
| Spend                             | no lost or double-counted spend: the ledger's growth = the company's `model_calls` cost (within one micro-dollar per call), no hold left open          |
| Outbox lag                        | p95 ≤ **60 s**, event written → published, and nothing left unpublished (`LOAD_TEST_OUTBOX_LAG_P95_MAX_MS`)                                            |
| Budget contention                 | many holds at once admit **exactly** what the budget has room for, all refusals are `CompanyBudget`, and releasing them puts the budget back as it was |

Starting values: the Development Plan's open question is closed with these. Tune them on real traffic after launch.

## What it does

`python -m diletta_evals load` (`pnpm load:run`), two phases:

1. **Chats.** `POST /eval/load/window` starts a window (the DO's timings start over). Then N simulated users each: get a companion JWT from the test host, read `GET /widget/bootstrap`, open `GET /widget/ws` (the JWT in `Sec-WebSocket-Protocol`), wait for the conversation frame, send the host token, and wait at a gate until every user is connected, so the chats are all open together. Each sends `--turns` turns (one at a time, `--think-seconds` apart: a user may send 10 messages a minute) and the first `--rate-down-percent` of the users rate their first reply down, which writes a critical event. When the chats end the harness waits for the budget, the `model_calls` usage and the outbox to settle (`--drain-seconds`), then reads `GET /eval/load/summary` and checks it.
2. **Contention.** A new window. `--contention-calls` holds (`POST /eval/load/reserve`) hit the company's budget at once, each sized so about half fit; every admitted hold is released (`/release`, at no cost). The budget must admit exactly `room ÷ hold` of them and end where it began.

The model is the stub: every call answers the same reply with the same usage after a ~150 ms first-token delay, so chats overlap like real ones and a run's cost is calls × one price.

## What the numbers mean

- **BudgetDO p95** comes from the DO itself: each `admitTurn` / `reserve` / `settle` is timed from its start to its answer, the last 5,000 of each kept in memory (`BudgetDO.getTimings`). Workers' clock moves only at I/O, so a call that never waits counts 0 ms and one that waits for Neon (the ledger's load) counts the wait. A DO evicted mid-run starts its timings over; the run then fails "BudgetDO counted the whole run" (rerun it).
- **Contention round trips** are the Worker's own: from calling the DO to its answer, so queueing behind the other holds is in it.
- **Spend** compares the ledger's growth (`spentMicros`, from `BudgetDO`) with the sum of the company's `model_calls.cost_usd` since the window began (Embed rows left out, as the budget does). A lost settle expires into spend at its whole hold, far above the allowance.
- **Outbox lag** is `published_at − created_at` of the company's `event_outbox` rows since the window began. The after-commit relay publishes within seconds; a row it missed waits for the 15-minute Cron sweep (ADR 0004) and fails the run.
- Turn time (first chunk, whole turn) is printed for information; it has no target.

## Set up (once)

1. **A load test company on staging.** Create it like any company (operator page). Give it a staging connection on the test host (base URL `https://diletta-test-host-staging.hatiprithwish.workers.dev/v1/`, auth JWT forward, the test host as JWT issuer) whose **allowed origins** include the origin you will set as `LOAD_ORIGIN`. Add a chatbot with a published config (any persona; no tools needed) and note its public id.
2. **A stub model key.** Settings › Model keys: add an Anthropic key with the value `diletta-load-stub-<anything>`. The key check goes to the stub too, so it is accepted. (A real key would work as a key but the calls would go to the real gateway.)
3. **A budget the run fits in.** Settings › Budget: at least **$200**. Each held call reserves its worst case (the prompt at 3 characters per token and the whole output cap), and 50 chats hold several at once; the contention phase splits the room into holds of room ÷ 100, so the room must be at least `--contention-calls ÷ 2` micro-dollars and at most `--contention-calls ÷ 2` × $1,000.
4. **The company's public id in staging.** Set `LOAD_TEST_COMPANY_ID` in `apps/backend/wrangler.jsonc` (`env.staging.vars`) to its public id and deploy the Worker. Until it is set every `/eval/load/*` route is 403.
5. **GitHub `staging` environment.** Variables `LOAD_COMPANY_ID` (its public id), `LOAD_CONNECTION_ID` (its staging connection's public id), `LOAD_CHATBOT_ID`, `LOAD_ORIGIN`; secrets `EVAL_JWT_PRIVATE_KEY` and `TEST_HOST_ADMIN_SECRET` are the eval harness's (`docs/runbooks/evals.md`).
6. **Deploy the test host and the Worker** from this branch's merge, so `/model-stub/anthropic/v1` and `/eval/load/*` exist and `MODEL_BASE_URL_OVERRIDE` is set.

Locally, copy the `LOAD_*` lines of `evals/.env.example` into `evals/.env`.

## Run it

- **GitHub:** Actions › "Load test (staging)" › Run workflow (inputs: users, turns, contention calls). It fails when the target is missed (exit 1) or the run couldn't happen (exit 2); the log has every check and the job summary the table.
- **Locally:** `pnpm load:run` (add `--users 5 --turns 2` for a smoke run: it can't meet the 50-chat target, so it ends FAILED by design, but every other check is real).

```
Chats
  PASS  50 chats open at once: 50 users, 50 connected, peak 50 open together
  PASS  Every turn answered: 200/200 turns
  ...
Contention
  PASS  Exactly the room the budget had was admitted: 100 of 200 holds ...
PASSED
```

Exit codes: 0 the target was met, 1 it ran and missed it, 2 it couldn't run (a setting, the backend, the host). Never read a 2 as the platform failing.

## When it fails

| Failing check                                | Look at                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 50 chats open at once / Every turn answered  | The failures it prints (the first few, by kind). `unavailable`: the budget or the key (`docs/runbooks/budget.md`, `model-keys.md`); `upgrade refused`: origins on the connection, the company's status |
| No server error                              | Sentry / Worker logs for the 5xx; a Neon connection limit under 50 sockets is the usual cause                                                                                                          |
| BudgetDO admit / reserve / settle p95        | Neon latency (the ledger loads once per refresh, `BUDGET_REFRESH_MS`), Hyperdrive pool limits                                                                                                          |
| Every hold settled                           | `Budget not settled; the hold expires into spend` errors (`docs/runbooks/budget.md`)                                                                                                                   |
| No lost or double-counted spend              | The summary line: ledger growth vs `model_calls` cost. A large gap = a lost settle (expired holds), a small one over the allowance = a recording bug                                                   |
| Outbox lag                                   | The relay (`EventOutboxRepo.relayEvents`) and the Queue; a row left unpublished waits for the 15-minute sweep                                                                                          |
| Exactly the room the budget had was admitted | `BudgetDO.reserve` / `BudgetLedgerProvider.checkReserve`: an over- or under-admit under concurrency is a budget bug, not noise                                                                         |

## Safety

- `/eval/load/*` takes only an eval JWT for an active **staging** connection (`authenticateEval`) of **the load test company** (`LOAD_TEST_COMPANY_ID`; `requireLoadCompany`), so a token for any other company, or any production connection, is refused (401 / 403). The var is empty in production and local.
- The contention holds are released at no cost; a hold the harness never released expires into spend at its whole amount (`BUDGET_RESERVATION_TTL_MS`). Run it on the load test company only.
- The stub serves only a stub key and answers a fixed text, so nothing a chat sends reaches a provider.
- The simulated users are test host users in a workspace of the run's own; their chats are ordinary widget chats of the load test company (they show on its dashboard, and its Quality page gets the rated replies). Nothing of it touches another company.
