# Claude Instructions

> Non-negotiable. Every session.

## Read first

- Your task row in `Development Plan v1.md` and its **Architecture baseline** section. The baseline lists locked decisions; changing one needs an ADR in `docs/adr/` first.
- `docs/architecture/companion-architecture-v0_15.excalidraw` — schema source of truth (30 tables, 8 groups).
- UI tasks: `docs/design/README.md` says which design files go with which task.

## Principles

- **Scan before code.** Read the closest golden file below before writing anything new. Mirror its naming, imports, and folder placement. No pre-existing pattern → flag it, don't assume.
- **Ambiguity halt.** Requirement unclear or conflicts with existing architecture → stop, ask one specific question. Don't guess.
- **No stubs.** No `// TODO`, placeholders, or partial features. Every delivered feature fetches, renders, errors, and empties end-to-end.
- **Multi-file features need a plan first.** Before writing code that touches >1 file, output: files to create/modify, golden file mirrored, new packages needed (if any — ask before adding), ambiguities. Wait for confirmation.
- **Ship complete.** All files in one response, fully wired — no "you'll need to connect this yourself."

### Golden files

| Layer               | File                                                 |
| ------------------- | ---------------------------------------------------- |
| DAL                 | `apps/backend/src/data-access-layer/NotesDAL.ts`     |
| Repository          | `apps/backend/src/repositories/NotesRepo.ts`         |
| Routes              | `apps/backend/src/routes/NotesRoutes.ts`             |
| Frontend data layer | `apps/web/src/routes/_authenticated/notes/-data.ts`  |
| Frontend page       | `apps/web/src/routes/_authenticated/notes/index.tsx` |

Notes is the scaffold example on D1. M0-5 adds tenant-aware DAL + Repo golden files and updates this table; until then, follow Notes.

## Stack

Monorepo (pnpm workspaces): `apps/web` (TanStack Start, React 19, Cloudflare Workers, Clerk) · `apps/backend` (Hono, Drizzle, D1 → Neon Postgres via Hyperdrive in M0-2) · `packages/schemas` (Zod schemas + types, source of truth for all types — never duplicate one in an app).

Planned, not yet created: `apps/widget` (chat widget, Shadow DOM), `packages/ui` (shadcn, from M0-4), `packages/crypto`, `packages/adapter`, `evals/` (Python harness). Don't create them outside their task.

**Approved packages — don't introduce alternatives:** routing `@tanstack/react-router`+`react-start` · server state `@tanstack/react-query` · client state `zustand` · forms `@tanstack/react-form` (not react-hook-form) · validation `zod` v4 · UI `shadcn/ui` + Tailwind v4 · icons `@phosphor-icons/react` · auth `@clerk/tanstack-react-start` (web) / `@clerk/backend` (worker) · HTTP `hono` v4 + `@hono/zod-validator` · ORM `drizzle-orm` (D1 now, Postgres from M0-2) · logging `@logtape/logtape` via `AppLogger` (never `console.log`) · errors Sentry · tests Vitest + RTL.

**Known drift in the scaffold — don't copy it:** `react-hook-form` and `@hookform/resolvers` are installed but unused; never use them. `apps/web/components.json` sets `iconLibrary: remixicon`, so `sonner.tsx` and `dropdown-menu.tsx` import Remix icons; use Phosphor in all new code. Fonts are Figtree / IBM Plex until M0-4 switches to the design fonts.

Before using any third-party API: check the installed version in `package.json`, read its file under `llm-context/`, and use context7 if still unclear. Never code against training-data memory of a library.

## New feature checklist

1. `packages/schemas/src/<feature>/` — `<Feature>Common.ts`, `<Feature>ApiRequest.ts`, `<Feature>ApiResponse.ts`, `<Feature>DALRequest.ts`, `index.ts`; export from `packages/schemas/src/index.ts`. Add `LogCategory`/`LogAction` entries in `log.ts`. Status fields get the Status Enum Pattern (below).
2. `apps/backend/src/db/tables.ts` — add the table (see Database below), then `pnpm --filter backend db:generate` immediately, commit the migration with the schema change. Update the architecture diagram in the same PR.
3. `data-access-layer/<Feature>DAL.ts` → `repositories/<Feature>Repo.ts` → `routes/<Feature>Routes.ts`, mounted in `apps/backend/src/index.ts`.
4. `apps/web/src/routes/_authenticated/<feature>/` — `-data.ts`, `index.tsx`, `new/index.tsx` and `$id/index.tsx` if applicable, `-Component.tsx` co-located (prefixed `-`).

**Layers never skip or reverse:** Routes → Repo → DAL → DB.

## Conventions

- **Status Enum Pattern** (any discrete-state field): DB stores int only. Define `<Feature>StatusIntEnum`, `<Feature>StatusLabelEnum`, `<FEATURE>_STATUS_LABEL_MAP` in `<Feature>Common.ts`. DAL returns raw int; Repo maps int→label in a private `withStatusLabel`; API response always carries both `<feature>Status` (int) and `<feature>StatusLabel` (string). See `NotesCommon.ts` / `NotesRepo.ts`.
- **Public ID Pattern** (every table): `id` is internal-only — joins and references, never sent to or accepted from a client. `publicId` (`Utility.generatePublicId()`, unique-indexed) is client-facing — every route param, API response, and frontend reference uses it instead. DAL generates it on insert and finds rows by it; API response types structurally omit `id` (`Omit<Note, "id">`). See `NotesCommon.ts` / `NotesDAL.ts` / `NotesRoutes.ts`.
- **DAL**: class holding `private db`, ctor takes `env`. Every method inits `{ isSuccess: false }`, try/catch, `AppLogger.error` with `LogCategory`/`LogAction` on failure.
- **Repo**: thin — maps API shapes to DAL params, business logic lives here, not in DAL.
- **Routes**: `checkAuth` first, then `zValidator`. `c.get("clerkUserId")` for the user. 201/200/404/500.
- **Frontend `-data.ts`**: `Queries` class with hierarchical keys (`keys.all()` invalidates every detail). `setQueryData` on update, `removeQueries` on delete, `mutateAsync` when the caller must await, `mutate` otherwise. Every mutation needs a non-empty `onError` (toast).
- **Frontend pages**: `useAuth()` at page level, explicit loading/error states, all requests through `apiClient`.
- **Routes needing user data** live under `_authenticated/` — always.

## Database

**Now (D1, until M0-2 lands):** `sqliteTable` aliased `table`; camelCase in code, `snake_case` in DB; timestamps as `t.integer({ mode: "timestamp" })`; `createdAt` notNull + `updatedAt` nullable; index every FK; unique-index `publicId` and any other unique field.

**From M0-2 (Neon Postgres via Hyperdrive, Drizzle pg, query cache off)** — these replace the D1 rules above:

- ids: `bigint` identity, internal only; `publicId` everywhere else.
- `created_at` and `updated_at`: `NOT NULL default now()`.
- No DB foreign keys: the DAL checks references. Index every reference column.
- RLS policies, partitions and `halfvec` live in raw-SQL migrations next to drizzle-kit output.

**From M0-5 (tenant pattern):**

- Tenant queries only inside `withTenant(companyId, tx => ...)`, which sets `set_config('app.company_id', …, true)` per transaction. Never set RLS context per session. DAL methods take `tx`; Repo opens the transaction.
- Transactional flows (outbox, action engine) throw to roll back; plain CRUD keeps the `{ isSuccess }` response pattern.
- Critical events: `activity_log` + `event_outbox` row in the same transaction.
- A new tenant table ships with its RLS tests in the same PR.

## Runtime

- Model calls only through the model router, on the company's own key via AI Gateway. No direct provider SDK calls.
- Never log or persist the host bearer token. It lives in Durable Object memory only.
- Config spec and tool ops are Zod schemas in `packages/schemas`. Changing a shape = bump `schema_version` + add an upgrader.

## UI

- Spec: `docs/design/DESIGN.md`. Pair every UI task with the light **and** dark screenshot of the screens it touches. `docs/design/pages/*.html` are layout and copy references only — never copy their inline styles.
- Colours only through the theme tokens (`docs/design/tokens/theme.css`) via Tailwind classes (`bg-primary`, `text-brand-text`, `bg-diff-new`). Lime (`primary`) is a fill only; for lime text use `brand-text`. No raw hex values in components.
- `font-mono` only for machine values: record IDs, tool names, model names, config versions, keys.
- Never show internal names (`turn_id`, `change_requests`, `needs_human`) in the UI. Copy follows DESIGN.md §8.
- Tailwind only, no CSS modules. shadcn used as-is or via `className`; never edit the component files inside an app. Until M0-4 they live in `apps/web/src/shadcn/ui/`; after M0-4 in `packages/ui` (shared by `apps/web` and `apps/widget`), added with the shadcn CLI.
- Charts need Recharts (shadcn `Chart`), which isn't installed — ask before adding it.

## Naming

- Actor columns: `<verb>_by` → admins. Booleans: `is_` / `has_` / `was_`. Product word: "chatbot".

## Done means

- The task's "Done when" from the dev plan is shown in the PR.
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
- From M0-5: a tenant query outside `withTenant`
- `npm`/`yarn` — `pnpm` always

## Commands

```bash
pnpm dev                          # web + backend together
pnpm dev:web                      # web app only
pnpm dev:backend                  # backend worker only
pnpm lint
pnpm format:check
pnpm --filter web test
pnpm --filter backend test
pnpm --filter backend db:generate # generate migration after schema change
pnpm --filter backend db:migrate  # apply migration (D1 remote; no local variant yet)
```

---

> Scan. Verify. Plan. Implement completely. The repo is the source of truth over training memory.
