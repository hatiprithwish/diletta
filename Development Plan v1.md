# Companion Platform: Development Plan v1

Oct 3, 2026 · @Prithwish WBB

## Purpose and scope

v1 ships the whole Companion Platform in one launch, with eRegister as the first customer and no fixed date: each milestone ends at exit criteria, not a calendar day. The build follows architecture v0.15 and the widget and dashboard designs in the design canvas.

**In v1**

- Chat widget (themeable UI, light and dark): Q&A with citations, approved writes with diff, edit, bulk review, verify, undo, mismatch handling, unavailable state.
- Agent runtime: Conversation DO on Think, model router on the company's own key, BudgetDO, tool definitions with read-before, read-after and undo.
- Knowledge: sitemap, URL and upload sources, hybrid search, doc-gap clusters.
- Evals: gate on the company's staging connection, safety hard gate, nightly platform suite on our own test company.
- Dashboard: all 14 pages designed (Overview to Settings › Budget).
- Multi-bot ready schema, with one default bot per company in the UI.

**Not in v1:** notifications, plans and billing, admin roles beyond operator and company admin, host-exec and MCP adapters, per-company infra cost, data residency. Each is additive on top of the outbox and the authz function.

Because v1 launches once, everything runs first on our own test company, then on eRegister staging, then on eRegister production (see Launch readiness).

## Team and working agreements

Four lanes, owned by 2–4 engineers; with two people, one owns Platform + Runtime and the other owns Product + Knowledge/Evals.

| Lane              | Owns                                                             | Typical first tasks |
| ----------------- | ---------------------------------------------------------------- | ------------------- |
| Platform          | Neon schema, DAL + Repo, RLS, crypto, outbox, Edge API, CI       | M0, M1              |
| Runtime           | Conversation DO, router, BudgetDO, tools, adapter, action engine | M2, M3              |
| Product           | Widget, dashboard, packages/ui (shadcn), authz in UI             | M2 widget shell, M4 |
| Knowledge + Evals | Ingestion, search, doc gaps, Python harness, gate                | M2 knowledge, M5    |

**Agreements**

- One task = one pull request = one Claude Code session, started from the task's row in this doc.
- The Pattern Enforcer reviews every PR first, then a human does. Security-critical paths need a second reviewer: RLS, crypto, auth, action engine, budget.
- The v0.15 diagram is the schema source of truth. A PR that changes a table updates the diagram in the same PR.
- Changing a locked decision (Architecture baseline) needs a short ADR in `docs/adr/` first.
- The `staging` branch deploys to staging. `main` deploys to production.

## Repository and tooling

Companion starts from the team scaffold ([hatiprithwish/diletta](https://github.com/hatiprithwish/scaffold)): a pnpm workspace built with `pnpm -r`, no Turborepo, keeping its folder names, golden files, `llm-context/` docs and Pattern Enforcer. New pieces are marked _new_; the Python eval harness builds with its own toolchain.

```text
companion/                    (from scaffold)
  apps/
    backend/      Hono Worker, becomes the platform worker: Edge API,
                  Conversation DO (Think), BudgetDO, Queue consumers,
                  Cron, outbox relay. db/, data-access-layer/,
                  repositories/, routes/ as in the scaffold.
                  D1 → Neon Postgres via Hyperdrive (Drizzle pg)
    web/          TanStack Start dashboard + Clerk
    widget/       new: widget UI bundle, renders in Shadow DOM
  packages/
    schemas/      Zod schemas + types, single source: config spec,
                  tool ops, eval cases, enums, LogCategory/LogAction
    ui/           new: shadcn moved from apps/web/src/shadcn/ui,
                  Tailwind preset, lime theme (light + dark)
    crypto/       new: envelope encryption
    adapter/      new: Adapter + AuthStrategy
  evals/          new: Python harness (DeepEval), types from schemas
  llm-context/    scaffold docs + new: neon, hyperdrive, durable-objects,
                  think, ai-gateway, queues, pgvector
  docs/           new: architecture/ (v0.15 diagram), adr/, runbooks/
  .github/        scaffold deploy workflows + Pattern Enforcer
  CLAUDE.md
```

| Environment | Workers                                           | Database              | Used for                            |
| ----------- | ------------------------------------------------- | --------------------- | ----------------------------------- |
| Local       | `pnpm dev`                                        | Neon staging (shared) | daily work, local tests             |
| Staging     | scaffold staging workflows, on push to `staging`  | Neon staging          | our test company, eRegister staging |
| Production  | scaffold production workflows, on merge to `main` | Neon production       | eRegister live                      |

CI on every PR: lint, typecheck, unit tests, integration and RLS tests against Neon staging, a JSON Schema drift check between `packages/schemas` and `evals/`, and the Pattern Enforcer against `.github/pattern-rules.md`. Merges to `main` also run the platform eval suite against staging.

## Architecture baseline

Build against `docs/architecture/companion-architecture-v0_15.excalidraw` (30 tables, 8 groups). These decisions are locked; changing one needs an ADR.

**Data and tenancy**

- Neon Postgres via Hyperdrive, query cache off. No DB foreign keys: the DAL checks references (scaffold layers Routes → Repo → DAL → DB).
- Every tenant query carries `company_id`, and RLS context is set per transaction with `set_config(…, true)`.
- Critical events: `activity_log` + `event_outbox` row in the same transaction, relayed to the Queue.
- `turn_id` (ULID from the Conversation DO) on messages, tool calls and model calls.
- Embeddings are `halfvec(1024)` from Workers AI, the only platform-paid model calls.

**Runtime and actions**

- Every model call uses the company's own key via AI Gateway. Key failure shows "temporarily unavailable" and opens a system quality issue.
- `BudgetDO` per company: reserve before each model call, settle after. Eval cost counts toward the budget.
- Tools are data: `call_op`, `readback_op {compare}`, `inverse_op`, with `{args.*} {before.*} {result.*}` placeholders.
- Host token lives in DO memory only. When missing, the DO sends `token_needed` and the widget fetches one silently; widget closed means `needs_human`.
- Config refreshes at the next turn after a publish. Approval expiry and undo window are platform defaults.

**Edge and identity**

- Widget talks over WebSocket, JWT sent in `Sec-WebSocket-Protocol` and verified before the upgrade (ADR 0001; was: JWT as the first message). Issuer → `company_connections` row, JWKS derived from issuer.
- `/eval/*` accepts only a platform-signed eval JWT, and only for staging connections.
- One `can(admin, action, resource)` check for every dashboard action.

**Evals and quality**

- Gate runs on the company's staging env: state-independent cases, readback asserts, `reset_op` after the run. Safety failures block publish.
- Couldn't-answer questions feed doc-gap clusters on the Knowledge page, plus one Quality item per growing cluster.

**Naming**

- Actor columns are `<verb>_by` → admins. Booleans use `is_` / `has_` / `was_`. The product word is "chatbot".

## Components

Every component in the HLD maps to one package and one lane; tasks in the breakdown reference these names.

| Component                                                 | Location                                                     | Lane              | Milestone |
| --------------------------------------------------------- | ------------------------------------------------------------ | ----------------- | --------- |
| Schema, migrations, DAL, Repo, RLS                        | `apps/backend/src/db`, `data-access-layer/`, `repositories/` | Platform          | M1        |
| Envelope crypto, company keys                             | `packages/crypto`                                            | Platform          | M1        |
| Outbox relay, activity log writer                         | `apps/backend`                                               | Platform          | M1        |
| Edge API (Hono): widget, dashboard, operator, eval routes | `apps/backend/src/routes`                                    | Platform          | M1–M2     |
| Config spec v1 + loader with upgraders                    | `packages/schemas`                                           | Runtime           | M1        |
| Conversation DO (Think), turn loop, `turn_id`             | `apps/backend`                                               | Runtime           | M2        |
| Model router + AI Gateway client                          | `apps/backend`                                               | Runtime           | M2        |
| BudgetDO                                                  | `apps/backend`                                               | Runtime           | M2        |
| Knowledge ingestion, hybrid search, rerank                | `apps/backend`                                               | Knowledge + Evals | M2        |
| Adapter + AuthStrategy (`jwt_forward`)                    | `packages/adapter`                                           | Runtime           | M3        |
| Action engine: diff, approve, commit, verify, undo        | `apps/backend`                                               | Runtime           | M3        |
| Widget UI + token refresh                                 | `apps/widget`                                                | Product           | M2–M3     |
| Dashboard (14 pages) + authz                              | `apps/web`                                                   | Product           | M4        |
| Doc-gap pipeline + clustering                             | `apps/backend`                                               | Knowledge + Evals | M5        |
| Eval harness, gate, nightly suite                         | `evals/`                                                     | Knowledge + Evals | M5        |
| UI kit: shadcn + Tailwind, lime theme, light + dark       | `packages/ui`                                                | Product           | M0        |

## Milestones

Milestones end at exit criteria, not dates; M2 and M3 are the critical path, and dashboard and evals run in parallel after M3.

&#91;embedded content: milestones M0 to M7 · dependencies and the launch gate\]

Dashboard UI work can start on fixtures right after M1; it switches to real data once M3 lands. Exit criteria for each milestone sit at the top of its task table.

## Task breakdown

Each row is one PR for one Claude Code session. Start a session with: "Read CLAUDE.md and the Architecture baseline in the dev plan, then do task \<ID>", and paste the row.

### M0 Foundations

Exit: the scaffold runs on Neon Postgres with the tenant transaction pattern as a golden file, `staging` deploys to staging and `main` to production. There are two environments only (staging, production) and two Neon branches; local dev uses staging. No dev branch, no per-PR preview Worker or Neon branch.

| ID   | Task                                                                                                                                                                           | Done when                                                  | Lane     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------- |
| M0-1 | Create the companion repo from the scaffold; rename Workers; keep Notes as the golden example until M0-5 replaces it                                                           | `pnpm dev` runs web + backend                              | Platform |
| M0-2 | D1 → Neon Postgres via Hyperdrive: Drizzle pg client, `bigint` identity ids, `updated_at NOT NULL default now()`, a raw-SQL migration folder for RLS, partitions and `halfvec` | Notes golden files pass their tests on Postgres            | Platform |
| M0-4 | Move shadcn from `apps/web/src/shadcn/ui` to `packages/ui`; Tailwind preset; lime theme, light + dark                                                                          | `apps/web` builds from `packages/ui`                       | Product  |
| M0-5 | Tenant pattern: `withTenant(companyId, tx)` helper; DAL methods take `tx`; transactional flows throw to roll back; new golden DAL + Repo on a tenant table                     | Golden files listed in CLAUDE.md                           | Platform |
| M0-6 | Extend CLAUDE.md, `pattern-rules.md` and `llm-context/` (Neon, Hyperdrive, Durable Objects, Think, AI Gateway, Queues, pgvector)                                               | Pattern Enforcer flags a tenant query outside `withTenant` | Platform |
| M0-7 | Secrets Store master key, `.dev.vars` template                                                                                                                                 | Local and staging read the master key                      | Platform |

### M1 Data, tenancy, crypto

Exit: all 30 tables migrated, RLS tests pass for every tenant table, outbox delivers to the Queue, config spec loads.

| ID   | Task                                                                                                                                                                                                                                               | Done when                                                                        | Lane     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| M1-1 | Migrations for all 30 tables: partial UQs, CHECKs, `halfvec`, monthly partitions on `activity_log`                                                                                                                                                 | Up and down run clean on a fresh branch                                          | Platform |
| M1-2 | Transaction helper: `set_config('app.company_id', …, true)` per transaction                                                                                                                                                                        | Test shows no context leak across pooled connections                             | Platform |
| M1-3 | RLS policies, incl. admins and platform eval cases                                                                                                                                                                                                 | Tenant A can't read or write tenant B, for every table                           | Platform |
| M1-4 | DAL + Repo per table group on the M0-5 golden files, reference checks instead of FKs                                                                                                                                                               | Writes with dangling refs fail in unit tests                                     | Platform |
| M1-5 | `packages/crypto`: company key create, rotate, encrypt, decrypt                                                                                                                                                                                    | Round-trip and rotation tests pass                                               | Platform |
| M1-6 | `activity_log` + `event_outbox` in one transaction, relay (`waitUntil` + Cron sweep), Queue consumer stub                                                                                                                                          | Killed relay leaves pending rows the sweep publishes; dedupe holds               | Platform |
| M1-7 | Config spec v1 in Zod, loader, upgrader registry, JSON Schema export                                                                                                                                                                               | Invalid spec rejected; JSON Schema from packages/schemas reaches `evals/`        | Runtime  |
| M1-8 | Dashboard auth with Clerk, `can(admin, action, resource)`, operator vs company admin                                                                                                                                                               | Unauthorized calls return 403 in tests                                           | Platform |
| M1-9 | `activity_log` partition maintenance: Cron creates monthly partitions 3 months ahead, alert if a month is missing. The worker's `diletta_app` role can't run DDL (M1-3): decide how the Cron gets owner rights, e.g. a `SECURITY DEFINER` function | Partitions always exist 3 months ahead; the default partition stays empty (test) | Platform |

### M2 Conversation core (Q&A)

Exit: a test-company user asks in the widget and gets a streamed, cited answer within budget, with every model call in `model_calls`.

| ID   | Task                                                                                           | Done when                                                            | Lane              |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------- |
| M2-1 | Widget auth: JWT as first WS message, issuer lookup, JWKS from issuer (KV), origin check       | Bad, expired and wrong-audience tokens rejected                      | Platform          |
| M2-2 | Conversation DO on Think: session, `turn_id`, messages read model, config refresh at next turn | Transcript in DO and `messages` match, with turn ids                 | Runtime           |
| M2-3 | Model router: tiers, company key decrypt, AI Gateway metadata, key-failure path                | Revoked key shows "temporarily unavailable" and opens a system issue | Runtime           |
| M2-4 | `BudgetDO`: reserve, settle, rollover, local step/turn/conversation caps                       | Over-budget call refused before reaching the provider                | Runtime           |
| M2-5 | Ingestion: sources → documents → chunks, `content_hash` skip                                   | Re-sync of an unchanged page makes zero embed calls                  | Knowledge + Evals |
| M2-6 | Hybrid search + rerank, source filter on chunks, tier-4 `model_calls` rows                     | Search respects a bot's source list                                  | Knowledge + Evals |
| M2-7 | Widget UI: launcher, welcome, chat, streaming steps, citations, feedback, unavailable          | Matches the design canvas in light and dark                          | Product           |
| M2-8 | Thumbs-down → `feedback` + `quality_issues` (source user)                                      | Issue appears with `feedback_id` set                                 | Runtime           |

### M3 Actions

Exit: approve → commit → verify → undo works end to end against the test host, and mismatch paths are covered by tests.

| ID   | Task                                                                                                     | Done when                                                        | Lane    |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| M3-1 | `tool_definitions` CRUD, op Zod schemas, placeholder renderer                                            | Renderer unit tests cover args, before, result                   | Runtime |
| M3-2 | Adapter + `jwt_forward` AuthStrategy, idempotency native and emulated                                    | Retried commit never writes twice                                | Runtime |
| M3-3 | Test host app for our test company: REST API over records                                                | Used by M3 tests and the platform suite                          | Runtime |
| M3-4 | Action engine: read-before, diff via `compare`, encrypted change request, durable pause, approval expiry | Pause survives DO eviction                                       | Runtime |
| M3-5 | Approve, edit, reject, bulk review in the widget                                                         | Edited values re-checked before commit                           | Product |
| M3-6 | Commit as user, read-after, compare → verified, auto-undo, or `needs_human`                              | All four outcomes covered by integration tests                   | Runtime |
| M3-7 | Undo within the window; purge values after it                                                            | `encrypted_changes` is null after the window                     | Runtime |
| M3-8 | Silent token refresh: `token_needed` → widget → host → DO                                                | Missing token recovers with no UI; closed widget → `needs_human` | Product |

### M4 Dashboard

Exit: all 14 pages live on staging with real data, light and dark, every action behind `can()`.

| ID    | Task                                                                                                                                  | Done when                                                    | Lane     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| M4-1  | Shell: shadcn Sidebar collapsing to an icon rail, bot switcher, grouped nav with Settings as a nested group, breadcrumb, theme switch | Matches the design canvas                                    | Product  |
| M4-2  | Rollups: hourly Cron into `activity_rollups` with `chatbot_id`                                                                        | Re-runnable for any company and day                          | Platform |
| M4-3  | Overview, Usage, Impact                                                                                                               | Numbers match raw `model_calls` and actions for a sample day | Product  |
| M4-4  | Conversations: list + transcript with per-turn cost                                                                                   | Turn totals equal `model_calls` by `turn_id`                 | Product  |
| M4-5  | Changes: list, detail timeline from `activity_log`, mark resolved                                                                     | `needs_human` items resolvable                               | Product  |
| M4-6  | Quality inbox: triage, create test (PII rewrite + review), fixed, dismissed                                                           | CHECKs on source and status hold                             | Product  |
| M4-7  | Knowledge: sources, sync status, gap clusters with sample questions                                                                   | Cluster links to the doc that closed it                      | Product  |
| M4-8  | Tests: runs, cases, failure detail with grader output                                                                                 | Opens transcript from R2                                     | Product  |
| M4-9  | Security: identity and origins, key rotation, retention and erasure, injection events, audit log                                      | Each action writes an audit row                              | Product  |
| M4-10 | Settings: Bots (versions, publish, rollback as copy, read-only switch), Model keys, Connections, Team, Budget                         | Publish blocked without a model key                          | Product  |

### M5 Evals and learning

Exit: publishing is blocked unless the gate passes, and the nightly platform suite runs and alerts.

| ID   | Task                                                                                                           | Done when                                          | Lane              |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| M5-1 | Eval case schema: readback asserts, tool calls, rubric, forbidden tools                                        | Generated Python types match packages/schemas      | Knowledge + Evals |
| M5-2 | Harness drives `/eval/*` with platform-signed eval JWT on the staging connection; k attempts; `reset_op` after | Runs against the test host and eRegister staging   | Knowledge + Evals |
| M5-3 | Graders: deterministic + pinned LLM judge on the company key; transcripts to R2                                | Unreachable judge fails the run with a clear error | Knowledge + Evals |
| M5-4 | Gate: draft, testing, ready, published; `approved_by_run_id`; safety hard gate                                 | A failing safety case blocks publish               | Runtime           |
| M5-5 | Nightly platform suite on our test company + daily production health alerts per bot                            | Alert fires on a seeded regression                 | Knowledge + Evals |
| M5-6 | Doc gaps: PII-stripped rewrite, embedding, clustering; one Quality item per growing cluster                    | No Quality item per single question                | Knowledge + Evals |
| M5-7 | Issue to test conversion with PII rewrite and admin confirm                                                    | Saved case has no names from the chat              | Knowledge + Evals |

### M6 Hardening

Exit: security review signed off, load test meets its target, runbooks written.

| ID   | Task                                                                                                         | Done when                                   | Lane     |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | -------- |
| M6-1 | Retention: content purge (DO, messages, files), gateway logs 7 days, Logpush lifecycle, null `doc_gaps` refs | Purged chat leaves only counts and gap text | Platform |
| M6-2 | User erasure end to end                                                                                      | Erased user's chats, files and secrets gone | Platform |
| M6-3 | Company key rotation job: re-encrypt, retire old version                                                     | No row left on the old version              | Platform |
| M6-4 | Prompt-injection logging + platform safety cases                                                             | Seeded injection logged and blocked         | Runtime  |
| M6-5 | Load test: concurrent conversations, `BudgetDO` contention                                                   | Meets the target set in Open questions      | Runtime  |
| M6-6 | Observability: Sentry, LogTape, outbox lag, relay failures, budget denials                                   | Alerts wired to the team channel            | Platform |
| M6-7 | Runbooks: key failure, `needs_human`, relay failures, config rollback                                        | In `docs/runbooks/`                         | All      |

### M7 eRegister launch

Exit: eRegister live in production, first week monitored.

| ID   | Task                                                                               | Done when                                          | Lane              |
| ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| M7-1 | eRegister connections: production + staging, issuer, origins, test user, reset API | Staging eval JWT works; production rejects it      | Platform          |
| M7-2 | eRegister tools from OpenAPI, then `compare` and `inverse_op` authored             | Every write tool has readback; undo where possible | Runtime           |
| M7-3 | Knowledge sources set up and synced                                                | Gap clusters start filling                         | Knowledge + Evals |
| M7-4 | eRegister eval cases incl. safety; gate passes on staging                          | Gate run approves the first config                 | Knowledge + Evals |
| M7-5 | Widget embedded in eRegister staging; internal pilot                               | Pilot users complete real tasks                    | Product           |
| M7-6 | Production publish and first-week watch                                            | Launch readiness all ticked                        | All               |

## Testing strategy

Tenant isolation and the action engine get the most tests, because a bug there leaks data or corrupts a customer's records.

| Layer           | What it proves                                                                    | Runs on                  | Blocks merge                |
| --------------- | --------------------------------------------------------------------------------- | ------------------------ | --------------------------- |
| Unit            | Zod schemas, placeholder renderer, router, budget math, crypto                    | Every PR                 | Yes                         |
| Integration     | Repo layer, outbox relay, action engine against the test host                     | Neon staging             | Yes                         |
| RLS suite       | Tenant A can't touch tenant B, for every table and Repo method                    | Neon staging             | Yes                         |
| Contract        | `packages/schemas` JSON Schema = Python harness types; widget ↔ DO message shapes | Every PR                 | Yes                         |
| Action outcomes | verified, auto-undo, `needs_human`, expired, rejected, token refresh              | PR + staging             | Yes                         |
| Platform evals  | Safety + core behaviour on our test company                                       | Merge to `main`, nightly | Blocks deploy to production |
| Customer gate   | The customer's cases on their staging env                                         | Every publish            | Blocks publish              |
| Load            | Concurrent chats, `BudgetDO`, outbox lag                                          | Before M7                | Launch gate                 |

A new table ships with its RLS tests in the same PR. A new write tool ships with an integration test for each of its outcomes.

## Launch readiness (eRegister)

eRegister goes live when every box below is ticked.

**Product**

- [ ] Every widget state in the design canvas works on eRegister staging, light and dark
- [ ] All 14 dashboard pages show eRegister data
- [ ] Pilot users completed real tasks on staging without engineer help

**Safety**

- [ ] Gate passes on eRegister staging, all safety cases included
- [ ] Every eRegister write tool has readback; non-undoable tools are marked
- [ ] Production rejects eval JWTs
- [ ] RLS suite green; security review signed off

**Operations**

- [ ] eRegister model key added and validated; judge reachable
- [ ] Budget, alerts and read-only switch tested
- [ ] Retention and erasure verified, gateway logs at 7 days
- [ ] Alerts and runbooks in place; on-call named for launch week
- [ ] Load test target met

## Risks and open questions

**Open questions** (each blocks the task named)

- [ ] Host token in Workflows for large commits: fresh token per step, or cap bulk size and skip Workflows in v1? (M3-4, review item #2)
- [x] JWT algorithm pinning: which algorithms eRegister signs with (M2-1, review item #7) — RS256 and ES256 only, `kid` required; `none` and HS\* rejected. Confirm eRegister signs with one of the two before M7.
- [x] Drizzle on Postgres (from the scaffold): which parts go to raw-SQL migrations beyond RLS, partitions and halfvec? (M0-2) — anything drizzle-kit can't express (RLS policies, partitions, extensions, `halfvec` columns and indexes) goes in a custom migration (`db:generate:sql`) in the same journal as drizzle-kit output.
- [x] Widget bundle size budget with React + shadcn from packages/ui inside Shadow DOM (M2-7) — 200 KiB gzipped for the script-tag bundle (`WIDGET_BUNDLE_MAX_GZIP_BYTES`, the build fails above it); 170.7 KiB at M2-7, with the widget's own small markdown parser instead of a library.
- [ ] Approval expiry and undo window default values (M3-4, M3-7)
- [ ] Load test target: concurrent conversations per company (M6-5)
- [ ] Cluster size that opens a Quality item (M5-6)
- [ ] Budget alerts at 50 / 80 / 100% of `spending_budget` (Cron in the architecture): no task owns them after M2-4. Fold into M6-6, or a new task? (see `docs/runbooks/budget.md` › Known gaps)
- [ ] Tool args must be checked against the tool's `input_schema` before `renderToolOp` (types, enums, required; the renderer drops a missing arg's key). Needs a JSON Schema validator: zod `z.fromJSONSchema` if it covers the keywords used, else a new package (ask first) (M3-4)
- [ ] A pinned tool version that is Disabled: leave the tool out of the turn, or refuse the turn? And should disabling a version pinned by a published config be blocked? (M3-4, M4-10)
- [ ] Loop guard (same tool + same args twice in a turn → stop) left out of M2-4 because no tools exist yet: add with the first tool calls (M3-1 / M3-4), in `ConversationDO.beforeTurn` `stopWhen`

**Risks**

| Risk                                      | Impact                      | Mitigation                                                       |
| ----------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| One launch means late feedback            | Problems surface only at M7 | Run the full product on our test company from M2 onward          |
| eRegister staging differs from production | Gate passes, live breaks    | Same tool definitions; readback on every write; first-week watch |
| Customer key quotas or outages            | Assistant unavailable       | Clear unavailable state, system issue, admin sees it on Overview |
| Think SDK or Hyperdrive behaviour changes | Rework in the runtime       | Pin versions; contract tests around the DO                       |
| Tenant leak through a missed `company_id` | Data exposure               | RLS suite per table, Repo layer only, second reviewer on DB code |

## CLAUDE.md

The scaffold's CLAUDE.md stays in force (golden files, layers, Public ID and Status Enum patterns, hard bans). Add these sections to it in M0-6; every Claude Code session reads it first.

```markdown
## Companion architecture

Read before any task: docs/architecture/companion-architecture-v0_15.excalidraw
(schema source of truth) and your task row in the dev plan.

## Database (Neon Postgres via Hyperdrive, Drizzle pg)

- Tenant queries only inside withTenant(companyId, tx => ...). Never set RLS
  context per session. DAL methods take tx; Repo opens the transaction.
- Transactional flows (outbox, action engine) throw to roll back; plain CRUD
  keeps the { isSuccess } response pattern.
- ids: bigint identity, internal only; publicId everywhere else.
- created_at and updated_at: NOT NULL default now().
- RLS policies, partitions and halfvec live in raw-SQL migrations next to
  drizzle-kit output. No DB foreign keys: check references in the DAL.
- Critical events: activity_log + event_outbox in the same transaction.

## Runtime

- Model calls only through the router. No direct provider SDK calls.
- Never log or persist the host bearer token. It lives in DO memory only.
- Config spec and tool ops are Zod schemas in packages/schemas. Changing a
  shape = bump schema_version + add an upgrader.

## UI

- shadcn lives in packages/ui (shared by apps/web and apps/widget). Add
  components there with the shadcn CLI; never edit them inside an app.

## Naming

- Actor columns: <verb>_by -> admins. Booleans: is_ / has* / was*.
  Product word: chatbot.

## Done means

- The task's "done when" shown in the PR, RLS tests for any new table.
- Schema change = diagram updated in the same PR.
- Locked decision changed = ADR in docs/adr first.
```
