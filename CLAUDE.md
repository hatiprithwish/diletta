# Claude Instructions

> Non-negotiable. Every session.

## Read first

- Your task row in `Development Plan v1.md` and its **Architecture baseline** section. The baseline lists locked decisions; changing one needs an ADR in `docs/adr/` first.
- `docs/architecture/companion-architecture-v0_15.excalidraw` — schema source of truth (30 tables, 8 groups).
- UI tasks: `docs/design/README.md` says which design files go with which task.
- `.github/pattern-rules.md` — what the Pattern Enforcer flags on every PR. Writing code that breaks a rule there fails review.

## Principles

- **Scan before code.** Read the closest golden file below before writing anything new. Mirror its naming, imports, and folder placement. No pre-existing pattern → flag it, don't assume.
- **Ambiguity halt.** Requirement unclear or conflicts with existing architecture → stop, ask one specific question. Don't guess.
- **No stubs.** No `// TODO`, placeholders, or partial features. Every delivered feature fetches, renders, errors, and empties end-to-end.
- **Multi-file features need a plan first.** Before writing code that touches >1 file, output: files to create/modify, golden file mirrored, new packages needed (if any — ask before adding), ambiguities. Wait for confirmation.
- **Ship complete.** All files in one response, fully wired — no "you'll need to connect this yourself."

### Golden files

| Layer                | File                                                  |
| -------------------- | ----------------------------------------------------- |
| Tenant transaction   | `apps/backend/src/db/withTenant.ts`                   |
| Platform transaction | `apps/backend/src/db/withPlatform.ts`                 |
| RLS migration        | `apps/backend/src/db/migrations/*_rls_policies/`      |
| DAL                  | `apps/backend/src/data-access-layer/ChatbotsDAL.ts`   |
| Repository           | `apps/backend/src/repositories/ChatbotsRepo.ts`       |
| Provider → DAL       | `apps/backend/src/providers/companyKey.ts`            |
| Schemas              | `packages/schemas/src/chatbots/`                      |
| Tenant tests         | `apps/backend/src/tests/chatbots.test.ts`             |
| RLS tests            | `apps/backend/src/tests/rls.test.ts`                  |
| Routes               | `apps/backend/src/routes/ChatbotsRoutes.ts`           |
| Durable Object       | `apps/backend/src/durable-objects/ConversationDO.ts`  |
| Workflow             | `apps/backend/src/workflows/KnowledgeSyncWorkflow.ts` |
| Frontend data layer  | none yet: first dashboard page sets it (M4)           |
| Frontend page        | none yet: first dashboard page sets it (M4)           |

Chatbots is the tenant golden example (M0-5), and since M1-8 also for routes. Operator routes follow `CompaniesRoutes.ts`. Until a frontend golden exists, follow the Conventions below and flag anything they don't cover.

## Stack

Monorepo (pnpm workspaces): `apps/web` (TanStack Start, React 19, Cloudflare Workers, Clerk) · `apps/backend` (Hono, Drizzle, Neon Postgres via Hyperdrive) · `packages/schemas` (Zod schemas + types, source of truth for all types — never duplicate one in an app) · `packages/ui` (`@app/ui`: shadcn components, `cn`, Tailwind preset `@app/ui/globals.css` with the lime theme, light + dark) · `packages/crypto` (`@app/crypto`: envelope encryption on WebCrypto AES-256-GCM, pure functions, no DB or logger).

Planned, not yet created: `apps/widget` (chat widget, Shadow DOM), `packages/adapter`, `evals/` (Python harness). Don't create them outside their task. Until M5, `evals/` holds only `evals/schemas/`: JSON Schema generated from `packages/schemas` (`pnpm --filter @app/schemas schema:export`), never edited by hand.

**Approved packages — don't introduce alternatives:** model calls `ai` v7 + `@ai-sdk/anthropic|openai|google` (only in `providers/aiGateway.ts`) · routing `@tanstack/react-router`+`react-start` · server state `@tanstack/react-query` · client state `zustand` · forms `@tanstack/react-form` (not react-hook-form) · validation `zod` v4 · UI `shadcn/ui` (style `radix-vega`) + Tailwind v4 + `cn` (shadcn's clsx/tailwind-merge replacement) · icons `@phosphor-icons/react` · auth `@clerk/tanstack-react-start` (web) / `@clerk/backend` (worker) · HTTP `hono` v4 + `@hono/zod-validator` · ORM `drizzle-orm` + `drizzle-kit` pinned to `1.0.0-rc.4` (for `bigint` string mode) + `pg` (node-postgres) on Hyperdrive · logging `@logtape/logtape` via `AppLogger` (never `console.log`) · errors Sentry · tests Vitest + RTL.

**Known drift in the scaffold — don't copy it:** `react-hook-form` and `@hookform/resolvers` are installed but unused; never use them.

Before using any third-party API: check the installed version in `package.json`, read its file under `llm-context/`, and use context7 if still unclear. Never code against training-data memory of a library.

`llm-context/` index — app stack: `ai-sdk.md`, `tanstack.md`, `clerk.md`, `hono.md`, `drizzle.md`, `zod.md`, `zustand.md`, `shadcn.md`, `tailwind.md`, `logtape.md`, `sentry.md`, `vitest.md`, `eslint.md`, `prettier.md`, `pnpm.md`, `github-actions.md`. Platform: `cloudflare.md` (per-product `llms.txt` index), `neon.md`, `hyperdrive.md`, `pgvector.md` (data); `durable-objects.md`, `think.md`, `ai-gateway.md`, `queues.md`, `workflows.md`, `workers-ai.md`, `r2.md` (runtime). Each platform file ends with how Diletta uses that product; those notes repeat locked decisions, they don't replace this file.

## New feature checklist

1. `packages/schemas/src/<feature>/` — `<Feature>Common.ts`, `<Feature>ApiRequest.ts`, `<Feature>ApiResponse.ts`, `<Feature>DALRequest.ts`, `index.ts`; export from `packages/schemas/src/index.ts`. Add `LogCategory`/`LogAction` entries in `log.ts`. Status fields get the Status Enum Pattern (below).
2. `apps/backend/src/db/tables.ts` — add the table (see Database below), then `pnpm --filter backend db:generate` immediately, commit the migration with the schema change. Update the architecture diagram in the same PR.
3. `data-access-layer/<Feature>DAL.ts` → `repositories/<Feature>Repo.ts` → `routes/<Feature>Routes.ts`, mounted in `apps/backend/src/index.ts`.
4. `apps/web/src/routes/_authenticated/<feature>/` — `-data.ts`, `index.tsx`, `new/index.tsx` and `$id/index.tsx` if applicable, `-Component.tsx` co-located (prefixed `-`).

**Layers never skip or reverse:** Routes → Repo → DAL → DB.

## Conventions

- **Status Enum Pattern** (any discrete-state field): DB stores int only. Define `<Feature>StatusIntEnum`, `<Feature>StatusLabelEnum`, `<FEATURE>_STATUS_LABEL_MAP` in `<Feature>Common.ts`. DAL returns raw int; Repo maps int→label in a private `withStatusLabel`; API response always carries both `<feature>Status` (int) and `<feature>StatusLabel` (string). See `ChatbotsCommon.ts` / `ChatbotsRepo.ts`.
- **Public ID Pattern** (every table, except the append-only/derived `activity_log`, `event_outbox`, `activity_rollups`, `eval_results`, `knowledge_chunks`; `admins` and `chatbot_users` use `clerk_user_id` / `host_user_id`): `id` is internal-only — joins and references, never sent to or accepted from a client. `publicId` (`Utility.generatePublicId()`, unique-indexed) is client-facing — every route param, API response, and frontend reference uses it instead. DAL generates it on insert and finds rows by it; API response types structurally omit `id` and every other internal id (`companyId`, `<verb>_by`), e.g. `Omit<Chatbot, "id" | "companyId" | "createdBy" | "updatedBy">`. See `ChatbotsCommon.ts` / `ChatbotsDAL.ts` / `ChatbotsRepo.ts`.
- **DAL**: tenant DALs hold no db. Every method takes `tx` from `withTenant` first and filters on `companyId`. Non-tenant DALs (`UsersDAL`) hold `private db` from a ctor taking `env`. Every method inits `{ isSuccess: false }`, try/catch, `AppLogger.error` with `LogCategory`/`LogAction` on failure. Where: one condition `.where(eq(…))`; two or more go in a `conditions` array built before the query (optional ones via `if (x) conditions.push(…)`), then `.where(and(...conditions))`. No inline `and(…)`, no `.where(() => …)` callback (drizzle accepts it on select only).
- **Repo**: thin. Maps API shapes to DAL params; business logic lives here, not in the DAL. Tenant Repos hold `private db = getDbClient(env)` and open one `withTenant` per method.
- **Provider → DAL**: a provider in `providers/` may call a DAL directly when several Repos share the step (e.g. `CompanyKeyProvider` reads `company_encryption_keys`), or when it holds one self-contained multi-DAL step a Repo runs inside its own transaction (e.g. `CriticalEventProvider`, `ModelKeyFailureProvider`). It takes the Repo's `tx` and never opens a transaction or builds a query itself; it returns `{ isSuccess, message }` and never throws. See `providers/companyKey.ts`.
- **Encryption** (`encrypted_*` columns): only through `CompanyKeyProvider.encryptValue` / `decryptValue` (company key create/rotate: `CompanyKeyProvider.createCompanyKey`, `CompanyEncryptionKeysRepo`), which use `@app/crypto`. Store `encryption_key_version` and `iv` with the ciphertext and decrypt with the row's version. Plaintext is encrypted in the Repo before the DAL; it never reaches a DAL param, a log or a route response (`getDecrypted*` responses are server-side only). Ciphertext, iv and key bytes stay out of log metadata.
- **Pagination** (any list that grows without bound): request extends `ZPageApiRequest` (`common.ts`) with a `<Feature>SortColumn` enum; Repo fills defaults (`Constants.DEFAULT_PAGE_NO`/`DEFAULT_PAGE_SIZE`, `createdAt` desc); DAL maps the sort column, then `.orderBy(expr, asc(<table>.id)).limit(pageSize).offset((pageNo - 1) * pageSize)`. Totals come from a separate `get<Feature>Count` returning `TotalRecordsResponse`. No cursors. See `ChatbotUsersDAL.ts`.
- **Routes**: `checkAuth` → `authorizeCompany(action)` (`/dashboard/*`) or `authorizePlatform(action)` (`/operator/*`) → `zValidator` → handler. Authorizing before validating means an unauthorized call gets 403, not 400. `c.get("companyId")` is the tenant key (from the signed-in admin, never the client). 201/200/403/404/500: a DAL not-found path sets `isNotFound: true` (with `isSuccess: false`), and the route answers `isSuccess ? 200 : isNotFound ? 404 : 500`, so a server error never shows as 404. Only `GET /dashboard/me` runs without an authorize middleware.
- **Authz (M1-8)**: one `can(admin, action, resource)` (`packages/schemas/src/authz/`) for every dashboard and operator action. A new action goes in `AuthzActionEnum` (and in `OPERATOR_ONLY_ACTIONS` if a company admin must never perform it). Roles are derived from `admins.company_id`: NULL = operator, set = company admin. No role column. Company admins are created on first sign-in from Clerk invite metadata (`companyPublicId`), which is consumed in the same transaction so a deleted row stays deleted; operators are added by hand only (`docs/runbooks/operators.md`). Never create an `admins` row with no company from code. Admins of a churned company have no access (`AdminsRepo.resolveAdmin`); paused keeps access.
- **Widget auth (M2-1, ADR 0001)**: `GET /widget/ws` takes the companion JWT in `Sec-WebSocket-Protocol` (`['diletta.v1', <jwt>]`), never in the URL, and decides everything before the upgrade. Only `WidgetAuthRepo.authenticate` turns it into a `WidgetIdentity` (server-side, internal ids): alg allowlist RS256/ES256 + `kid`, no `crit` → issuer → `company_connections` (`withPlatform`) → signature on the issuer's JWKS (`JwksProvider`, KV `JWKS_CACHE`, fetched only for a registered issuer, size-capped) → `aud = WIDGET_JWT_AUDIENCE`, `exp`/`nbf`/`iat`, lifetime ≤ 5 min → connection active + `Origin` in `allowed_origins` → active company and chatbot (`withTenant`). Every failure before the signature passes is 401, so only a signed token can see 403/404. Failures are HTTP statuses (`WIDGET_AUTH_FAILURE_HTTP_STATUS_MAP`) with a generic body; the answer selects `diletta.v1` only.
- **Conversation DO (M2-2)**: `ConversationsRepo.startOrResume` (worker, after auth) upserts the `chatbot_users` row and creates the conversation (with a `conversation.started` critical event as `root_log_id`) or resumes the user's own open one (else `ConversationStartFailureEnum.NotFound` → 404). The worker then forwards the upgrade to `ConversationDO` (`getAgentByName`, name = `conversations.public_id`) with a fresh header set carrying the session (`CONVERSATION_SESSION_HEADER`), and closes a conversation it just created if that upgrade fails; the DO has no public route. The DO extends Think, locked down: no workspace bash or MCP, and its one tool is `search_help_docs` (M2-6; `activeTools` names it only when the bot lists knowledge sources, else `[]`), no reasoning or identity frames, `onChatError` returns safe text only. Every inbound frame passes `WidgetFrameProvider.admit` (pure, unit-tested): a chat request is rebuilt to its newest user message with a new id; cancel and stream resume pass; everything else is refused. One turn at a time, refused while closing; the turn's ULID (`Utility.generateUlid`) and the activity time are stored at admission, then `loadTurnConfig` re-checks the conversation, chatbot and company and loads the published config (so a publish or a pause takes effect at the next message) and the model is routed; any failure → `{type:"unavailable"}` (or `closed`), nothing saved. `webSocketMessage` initializes the DO (`__unsafe_ensureInitialized`) before checking a frame, so after a hibernation wake the reused-id check sees the stored transcript. The read model is synced from the transcript (`TranscriptProvider`, position = the last synced message id, never an index) after every turn and, in `waitUntil`, on every wake, so a failed write or an evicted turn is caught up; `recordTurn` is idempotent on `session_message_id`. A conversation never closes over an unsynced backlog. A turn Think ends without a hook is released in a `finally` around the frame's dispatch. Auto-close after `CONVERSATION_IDLE_CLOSE_MS` (DO schedule, never sooner than `CONVERSATION_CLOSE_RETRY_MS` from now): Closed, Answered or Abandoned. DO runtime state goes through `patchRuntimeState` (no await between read and write).
- **Frontend `-data.ts`**: `Queries` class with hierarchical keys (`keys.all()` invalidates every detail). `setQueryData` on update, `removeQueries` on delete, `mutateAsync` when the caller must await, `mutate` otherwise. Every mutation needs a non-empty `onError` (toast).
- **Frontend pages**: `useAuth()` at page level, explicit loading/error states, all requests through `apiClient`.
- **Routes needing user data** live under `_authenticated/` — always.

## Database

**Neon Postgres via Hyperdrive (Drizzle `node-postgres`, Hyperdrive caching disabled):**

- `pgTable` aliased `table`; camelCase in code, `snake_case` in DB. Unique-index `publicId` and any other unique field.
- ids: `t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity()` (string in code, exact int64), internal only; `publicId` everywhere else.
- `created_at` and `updated_at`: `t.timestamp(..., { withTimezone: true }).notNull().defaultNow()` (append-only/derived tables above: no `updated_at`). DAL sets `updatedAt` on update. Status/type ints: `t.smallint()`.
- No DB foreign keys: the DAL checks references. Index every reference column.
- `halfvec` columns and HNSW indexes go in `tables.ts` (`t.halfvec("embedding", { dimensions: 1024 })`, `.using("hnsw", col.op("halfvec_cosine_ops"))`). RLS policies, partitions and extensions live in custom SQL migrations (`pnpm --filter backend db:generate:sql <name>`) in the same `src/db/migrations` journal as drizzle-kit output, so ordering is guaranteed.
- `activity_log` is partitioned by month (`*_partition_activity_log` migration), so its primary key is `(id, created_at)`. A daily Cron (`ActivityLogPartitionsCron` → `ActivityLogPartitionsRepo`) keeps the current UTC month and the next 3 partitioned, and alerts if a month is missing or `activity_log_default` holds rows (it must stay empty). Runbook: `docs/runbooks/activity-log-partitions.md`.
- `diletta_app` never gets DDL rights. Where the worker needs an owner action, it calls a `SECURITY DEFINER` function owned by the owner role that does one fixed thing, validates its arguments, sets `search_path = pg_catalog, public, pg_temp`, and is `REVOKE`d from `PUBLIC` and granted `EXECUTE` to `diletta_app` only. See `*_activity_log_partition_maintenance`.
- Every new migration folder gets a hand-written `down.sql` that reverses it (`--> statement-breakpoint` between statements). `db:rollback` runs it and removes the journal row.
- `dbClient.ts` builds a client per request from `env.HYPERDRIVE.connectionString`; never cache a client across requests.
- Environments: staging and production only. Two Neon branches (`staging`, `production`), each behind its own Hyperdrive config. Local dev and tests use the staging branch via `apps/backend/.env`; never point local at production. Tests must clean up the rows they create.
- Roles: the worker (Hyperdrive, and `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` locally) connects as `diletta_app`, which RLS applies to. The owner role (`DATABASE_URL`, `BYPASSRLS`) runs migrations and test fixtures/cleanup only, never code under test. Setup and password rotation: `docs/runbooks/app-role.md`.

**From M0-5 (tenant pattern):**

- Tenant queries only inside `withTenant(db, companyId, tx => ...)` (`companyId` = internal `companies.id`, resolved server-side), which sets `set_config('app.company_id', …, true)` per transaction. Never set RLS context per session. DAL methods take `tx`; Repo opens the transaction.
- Only exception: a backend test may set `app.company_id` per session (`set_config(…, false)`) as a leak-detection control, on a direct single-connection pool (never `NEON_POOLER_URL`), with `RESET app.company_id` in a `finally`. See pattern rule 3.2 and `withTenant.test.ts`.
- Transactional flows (outbox, action engine) throw `TenantRollbackError(dalResponse.message)` to roll back; `withTenant` turns it into `{ isSuccess: false, message }`. Plain CRUD keeps the `{ isSuccess }` response pattern. See `ChatbotsRepo.setDefaultChatbot`.
- Critical events: `activity_log` + `event_outbox` row in the same transaction, only through `CriticalEventProvider.record(tx, …)` inside the Repo's `withTenant` (`EventOutboxRepo.recordCriticalEvent` when the event is the only write). The caller derives a `dedupeKey`; a repeat, concurrent or not, is a no-op success (the provider holds a transaction-scoped lock on the key, so a concurrent repeat waits for the first commit). After commit, relay with `ctx.waitUntil(EventOutboxRepo.relayEvents({ companyId, outboxIds }))`; the per-minute Cron sweep publishes what that misses. Delivery is at-least-once: Queue consumers dedupe on `outboxId`, ack per message, go through a Repo. See `providers/criticalEvent.ts` / `EventOutboxRepo.ts`.
- Cross-company work (operator routes, Cron/Queue sweeps across companies, and the Clerk admin → company and JWT issuer → connection lookups) runs in `withPlatform(db, tx => ...)`, which sets `app.is_platform` per transaction and passes every policy. Anything scoped to one company uses `withTenant`, even for an operator.
- **RLS (M1-3):** every tenant table and `companies` has RLS enabled and forced, with a tenant and a platform policy; `admins` with no company (operators) and platform `eval_cases` never match a tenant, and tenants may read platform cases but not write them. The DAL still filters on `companyId` on top of RLS.
- A new table ships, in the same PR, a custom migration that grants it to `diletta_app` by name (no default privileges) and, for a tenant table, enables and forces RLS with both policies, mirroring `*_rls_policies`. A new tenant table also gets a `FIXTURES` entry in `rls.test.ts`, and new tenant Repo methods get cross-company tests run as `diletta_app`.

## Runtime

- Model calls only through the model router, on the company's own key via AI Gateway. No direct provider SDK calls.
- **Model router (M2-3)**: `ModelRouterRepo.getModel({ companyId, chatbotId, chatbotUserId, conversationId, evalRunId, turnId, taskType, tier, routing })` → `{ isSuccess: true, model } | { isSuccess: false, failure }`, never throws. Steps: tier (or `routing.defaultTier`) → provider + model; must be in `MODEL_PRICES` (`packages/schemas/src/modelRouter/`), else `ModelNotPriced`; active key decrypted in `withTenant` (`CompanyKeyProvider.decryptCompanySecret`); `AiGatewayProvider` (the only file that imports `@ai-sdk/*`) builds the provider-native model on AI Gateway with the key, `cf-aig-authorization` and `cf-aig-metadata`, wrapped by `ModelCallRecordingProvider`. That middleware holds every usage-status rule (Reported: provider usage, or a refusal with status ≥ 400 at 0; Pending: billed but no usage, incl. a finish without totals or an unreadable 2xx, backfilled by the per-minute Cron from the gateway log; Unknown: no log id) and turns every final failure into `ModelUnavailableError` (text `MODEL_UNAVAILABLE_MESSAGE`; an abort stays an abort), because Think sends a stream error's message to the widget as is. It also does the retrying (a retryable 408/409/429/5xx, up to `MODEL_CALL_MAX_RETRIES`, honouring retry-after and abort), since the SDK only retries its own errors; a gateway 5xx/408 counts as possibly billed (Pending), not refused. `ModelCallsRepo.recordModelCall` writes the row in `ctx.waitUntil`. Key failure = no active key, or the provider's own 401 / Google `API_KEY_INVALID` (never a 403, never a gateway error) → `ModelKeyFailureProvider` in the Repo's tx: key Invalid only if it still holds the value used (`invalidateModelKey`), and the company's one open System / ModelError issue covers the provider (which providers it covers is read from its `quality_issue.opened` / `provider_added` events, never the note). Never write a billed call as $0 Reported. A price change or new model = edit `MODEL_PRICES` with its source date. Setup and backfill: `docs/runbooks/ai-gateway.md`.
- **Budget (M2-4)**: every provider call is sized and held before it goes out, and a refused call never reaches the provider (pattern rule 3.24). `ModelCallRecordingProvider` estimates the prompt once per call and, per attempt (retries too), asks `budget.reserve` for a hold, then sends the attempt with the hold's `maxOutputTokens` straight to the wrapped model. `ModelCallBudgetProvider` (the router's only budget code) sizes it: input at the plain input rate, output ≤ `MODEL_CALL_MAX_OUTPUT_TOKENS`, cut to the caller's output tokens and cost left (a pricey model gets a shorter answer, not a refusal), refused under `MODEL_CALL_MIN_OUTPUT_TOKENS`; holds it in `GetModelRequest.caps` then `BudgetDO.reserve`; settles each record against its own hold (unknown usage keeps the whole cost hold but counts no output tokens). `ModelCallCaps` is the Conversation DO's `TurnBudget` (`src/budget/`, stateful per turn, so not in `providers/`): `maxTokensPerTurn` counts **output only**, plus `turnCostCapUsd` / `conversationCostCapUsd`. `BudgetDO` is one per company (reach it only via `BudgetDO.forCompany`; plain `DurableObject`, SQLite kv, micro-dollars via `usdToMicros`): every RPC request is Zod-parsed; billing period = UTC month, seeded from `SUM(model_calls.cost_usd)` through `BudgetRepo`; `spending_budget` re-read every `BUDGET_REFRESH_MS` (NULL = `DEFAULT_SPENDING_BUDGET_USD`, $10), a failed read retried after `BUDGET_LOAD_RETRY_MS`; chatbot-user daily cost and messages per minute live there too. Its math is pure in `BudgetLedgerProvider`; expired holds are charged before the ledger is read for a check, with no await between reading and writing; it fails closed (`Unavailable`). The Conversation DO checks `conversationTurnsPerHour` and `conversationCostCapUsd` before routing and `BudgetDO.admitTurn` after it (so a turn that can't run uses no rate slot); a rate refusal answers `BUDGET_RATE_LIMIT_MESSAGE`, any other `unavailable`, nothing saved. `beforeTurn` sets `stopWhen` (caps used up) and `timeout.totalMs` (`turnTimeoutSeconds`). Runbook: `docs/runbooks/budget.md`; its Known gaps list what isn't built yet (50/80/100% alerts, the tool loop guard) and where the count is knowingly off.
- **Knowledge ingestion (M2-5)**: sources → documents → chunks. A sync starts only through `KnowledgeSourcesRepo.startSync` (create of a web source, `POST /dashboard/knowledge-sources/:id/sync`, an upload or an upload source's resume, the hourly `KnowledgeResyncCron` for due Daily / Weekly sources, Failed ones after `KNOWLEDGE_FAILED_RETRY_MS`, and stale syncs): the source row is locked `FOR UPDATE` and claimed (Syncing + a new `sync_run_id` = the workflow instance id; refused while Paused or while its heartbeat is fresh), then `KnowledgeSyncWorkflowProvider` starts that instance (a failed start → Failed). Only the run whose id the source holds may write: every step locks the source, checks Syncing + `sync_run_id`, and refreshes `sync_heartbeat_at`; anything else answers Stopped and writes nothing (pause, delete and a newer claim take the same lock). Steps call `KnowledgeIngestionRepo`, return ids/outcomes only, and throw on a database failure so Workflows retries them. List (sitemap pages on the source's site, `www.` = apex, default port; `isComplete` false when a nested sitemap failed or a cap hit; a url; or an upload source's documents with work to do) → per item: fetch (`KnowledgeFetchProvider`: every redirect hop re-checked against the site, time/size caps) or read from R2 → `AI.toMarkdown` (`KnowledgeExtractProvider`; md/txt decoded by BOM/charset) → normalize (NUL dropped) → `content_hash` = `KNOWLEDGE_PIPELINE_VERSION:` + sha256 of the text. Indexed + same hash = Unchanged: no chunking, zero embed calls. Otherwise chunk → embed bge-m3 (`KnowledgeEmbedProvider`, the only embedding `AI.run`; rows via `KnowledgeModelCallsProvider`: tier Embed, provider `workers_ai`, usage Estimated, rounded up, never in the company budget) → write a new page's bytes to R2 as a new file (outside any lock), then one transaction re-reads the document, writes the file row (`KnowledgeDocumentFilesProvider`) and replaces the chunks; one document per (source, URL) (unique index). Prune only after a complete, non-empty listing. Finish → Active / Failed, plus a follow-up sync if uploads are still Pending. Bump `KNOWLEDGE_PIPELINE_VERSION` when the chunker or embedding model changes. A state refusal answers 409, an upload whose bytes don't match its type 400, an upload body over the cap 413 (`bodyLimit`). Tests never reach Workers AI (`remoteBindings: false`; mock the knowledge providers). Runbook: `docs/runbooks/knowledge.md`.
- **Knowledge search (M2-6)**: the model searches through the `search_help_docs` tool (`ConversationDO.getTools`); `beforeTurn` activates it and adds `SearchHelpDocsProvider.instructions` only when the turn's config lists sources. `KnowledgeSearchRepo.search` (never throws): the bot's `knowledge.sourceIds` (public ids) → internal ids that exist in the company, any status (Paused stops syncing, not search); none left or a blank query = no hits, no model call. Then embed the query (`KnowledgeEmbedProvider`, `search.embed`) → one `withTenant` with `hnsw.iterative_scan = relaxed_order` + `hnsw.ef_search` set per transaction: vector side (HNSW cosine) and keyword side (`websearch_to_tsquery` on the GIN `tsv`), each `KNOWLEDGE_SEARCH_CANDIDATES_PER_SIDE`, only Indexed documents and `embedding_model = KNOWLEDGE_EMBEDDING_MODEL` → RRF (`KnowledgeRankingProvider`, k = `KNOWLEDGE_SEARCH_RRF_K`) to `KNOWLEDGE_SEARCH_RERANK_CANDIDATES` → rerank (`KnowledgeRerankProvider`, bge-reranker-base, `search.rerank`; Workers AI returns probabilities in 0–1, used as they are, anything outside refused) → hits ≥ `KNOWLEDGE_SEARCH_MIN_SCORE`, at most `topK`. Rerank is per query, never stored. Every Workers AI call gets its `model_calls` row (`KnowledgeModelCallsProvider`: tier Embed, `workers_ai`, Estimated, rounded up, with the chatbot, user, conversation and turn) in `waitUntil`, failed calls too; never held against or counted in the company budget. The tool numbers hits across the turn (`ActiveTurn.citationCount`). Its output (transcript, widget) carries citations only; the excerpts stay in the running turn's memory (`ActiveTurn.searchExcerpts`, by tool call id) and reach only the model, inside the `<search_results>` fence (`SearchHelpDocsProvider.toModelText`: data, not instructions; fence tags in a chunk are defused). An earlier turn's search is shown as what it found (titles, no numbers or excerpts); an output Think trimmed reads as "no longer shown". The model cites `[n]`. A failed search tells the model search is unavailable; nothing low-scoring → "say you don't know". The read model stores `content.citations` (`{ n, documentPublicId, title, sourceUrl }`) for the markers a reply actually uses (`TranscriptProvider` → `SearchHelpDocsProvider.citedBy`). Tests mock `KnowledgeEmbedProvider` / `KnowledgeRerankProvider` (or `KnowledgeSearchRepo.search` in DO tests). Runbook: `docs/runbooks/knowledge.md`.
- Never log or persist the host bearer token. It lives in Durable Object memory only.
- Config spec and tool ops are Zod schemas in `packages/schemas`. Changing a shape = bump `schema_version` + add an upgrader.
- Config spec (`packages/schemas/src/configSpec/`): reads go through `loadConfigSpec({ schemaVersion, body })` (upgrade from the row's version, validate, then fill in today's platform defaults; the result is never written back). Writes go through `normalizeConfigBody(body)`: store its `body` at its `schemaVersion`, and compute `body_hash` over that body with sorted keys. Both return `{ isSuccess, message }` and never throw. Stored bodies hold only what the company set; platform defaults live in `ConfigSpecDefaults.ts`, unversioned, so changing a default value needs no bump. A shape change adds `ZConfigSpecV<n+1>` (never edit a released version, and give it no `.default()`), updates `currentVersion` / `currentSchema` and registers `defineConfigSpecUpgrader(ZConfigSpecV<n>, …)` under `n` in `ConfigSpecRegistry.ts` with a test, and reruns `schema:export` so `evals/schemas/` matches (the drift test in `jsonSchemaExports.test.ts` fails until it does).

## UI

- Spec: `docs/design/DESIGN.md`. Pair every UI task with the light **and** dark screenshot of the screens it touches. `docs/design/pages/*.html` are layout and copy references only — never copy their inline styles.
- Colours only through the theme tokens (`docs/design/tokens/theme.css`) via Tailwind classes (`bg-primary`, `text-brand-text`, `bg-diff-new`). Lime (`primary`) is a fill only; for lime text use `brand-text`. No raw hex values in components.
- `font-mono` only for machine values: record IDs, tool names, model names, config versions, keys.
- Never show internal names (`turn_id`, `change_requests`, `needs_human`) in the UI. Copy follows DESIGN.md §8.
- Tailwind only, no CSS modules. shadcn used as-is or via `className`; never edit the component files. They live in `packages/ui/src/components` (shared by `apps/web` and `apps/widget`), added with the shadcn CLI: `pnpm --filter @app/ui exec shadcn add <name>`. Import as `@app/ui/components/<name>`, and `cn` from `@app/ui/lib/utils`.
- Type scale from DESIGN.md §2 is in the preset: `text-page-title`, `text-metric`, `text-section`, `text-body`, `text-caption`, `text-mono-value`. Prefer them over arbitrary `text-[…]` sizes.
- shadcn components import bare `cn`; every app's `vite.config.ts` and `vitest.config.ts` must alias exactly `/^cn$/` to `packages/ui/src/lib/utils.ts`, or type-scale classes merge as text colours. Fonts load from Google Fonts in the app's document head.
- Charts need Recharts (shadcn `Chart`), which isn't installed — ask before adding it.

## Naming

- Actor columns: `<verb>_by` → admins. Booleans: `is_` / `has_` / `was_`. Product word: "chatbot".

## Done means

- The task's "Done when" from the dev plan is shown in the PR.
- A new tenant table ships with its grants, RLS policies and RLS tests (`rls.test.ts` `FIXTURES` entry).
- A new CLAUDE.md rule or hard ban gets a matching rule in `.github/pattern-rules.md` in the same PR.
- Schema change = architecture diagram updated in the same PR.
- Locked decision changed = ADR in `docs/adr/` first.

## Hard bans

- `console.log`, `any`, `@ts-ignore`/`as any` as a fix
- Types or Zod schemas defined outside `packages/schemas`
- Skipping a layer, or an authenticated route outside `_authenticated/`
- A client-supplied `id`, or an internal `id` in any response/param — `publicId` only
- Installing a package without asking, or one with a native browser API equivalent
- Disabling an ESLint rule inline without asking
- A schema change without immediately running `db:generate`
- A mutation with an absent or empty `onError`
- Logging or persisting the host bearer token; calling a model provider outside the router
- From M1-5: `crypto.subtle` on company data outside `@app/crypto`; a plaintext secret in a DAL param, log or route response
- From M0-5: a tenant query outside `withTenant` (or `withPlatform` for cross-company work)
- From M1-3: code under test on the owner connection; a table without its `diletta_app` grant and RLS policies; `withPlatform` for one company's data
- From M1-9: DDL rights or an owner connection string for the worker; a `SECURITY DEFINER` function without a fixed `search_path`, or executable by `PUBLIC`
- From M1-8: a `/dashboard/*` or `/operator/*` route without `authorizeCompany` / `authorizePlatform` (except `GET /dashboard/me`); app code inserting an `admins` row with no company
- `npm`/`yarn` — `pnpm` always

## Commands

```bash
pnpm dev                          # web + backend together
pnpm dev:web                      # web app only
pnpm dev:backend                  # backend worker only
pnpm lint
pnpm format:check
pnpm typecheck                    # tsc --noEmit in every package
pnpm test                         # all packages; each app's test runs typecheck first
pnpm --filter web test
pnpm --filter backend test        # hits the Neon staging branch via apps/backend/.env
pnpm --filter backend db:generate         # generate migration after schema change
pnpm --filter backend db:generate:sql <n> # empty custom SQL migration (RLS, partitions, extensions)
pnpm --filter backend db:migrate          # apply migrations to DATABASE_URL (apps/backend/.env = staging branch)
pnpm --filter backend db:rollback [n]     # run down.sql of the last n applied migrations (default 1)
```

---

> Scan. Verify. Plan. Implement completely. The repo is the source of truth over training memory.
