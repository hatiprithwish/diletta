# Pattern Rules & Custom Checks

> Single source of truth for all code validation rules enforced via the Pattern Enforcer workflow.
> Edit this file to add new rules. The workflow will automatically pick them up.

---

## 1. CLAUDE.MD ENFORCEMENT RULES

These rules are mandatory per CLAUDE.md.

### 1.1 Layer Boundary Violations [CRITICAL]

**Rule:** Routes → Repo → DAL → DB. Never skip or reverse layers.

**Violations:**

- Routes importing directly from Drizzle
- Routes importing directly from DAL
- Repo building queries with Drizzle (`select`/`insert`/`update`/`delete`/`sql`). Allowed in a Repo: `import type { NodePgDatabase } from "drizzle-orm/node-postgres"`, `getDbClient` and `withTenant` from `@/db/` (see `ChatbotsRepo.ts`)
- Durable Objects, Queue consumers or Cron handlers calling a DAL directly (they go through a Repo)
- Web components importing directly from worker DAL/Repo

**Detection:**

```
File: apps/backend/src/routes/*.ts
- ❌ import { drizzle } from "drizzle-orm"
- ❌ import { SomeDAL } from "../data-access-layer"
- ✅ import { SomeRepo } from "../repositories"

File: apps/web/src/**/*.tsx
- ❌ import { SomeDAL } from "@app/worker"
- ✅ Use apiClient through -data.ts query/mutation hooks
```

**Fix:** Route files should only import Repo. Repo imports DAL plus `getDbClient` / `withTenant` to open the transaction. Only the DAL builds queries.

---

### 1.2 Type Definition Location [CRITICAL]

**Rule:** All types and Zod schemas belong in `packages/schemas/src/` only.

**Violations:**

- Type definitions in `apps/web/src/`
- Type definitions in `apps/backend/src/`
- Zod schemas outside `packages/schemas/`
- Request/Response types in app folders instead of schemas

**Detection:**

```
File: apps/backend/src/**/*.ts
- ❌ type GetUserRequest = { id: string }
- ❌ export const UserSchema = z.object({...})
- ✅ import { GetUserRequest, UserSchema } from "@app/schemas"

File: apps/web/src/**/*.tsx
- ❌ interface UserResponse { ... }
- ✅ import { UserResponse } from "@app/schemas"
```

**Fix:** Move all type definitions to `packages/schemas/src/<feature>/` with proper structure.

---

### 1.3 Console.log Usage [CRITICAL]

**Rule:** Never use `console.log`. Always use `AppLogger`.

**Violations:**

- `console.log(...)`
- `console.error(...)`
- `console.warn(...)`
- `console.debug(...)`

**Detection:**

```
- ❌ console.log("debugging")
- ✅ AppLogger.info({ category: LogCategory.X, action: LogAction.Y, message: "..." })
```

**Fix:** Replace all console methods with `AppLogger` from `@app/schemas`.

---

### 1.4 TypeScript Type Safety [CRITICAL]

**Rule:** No implicit `any`, no `@ts-ignore`, no non-null assertions without guards.

**Violations:**

- `// @ts-ignore` comment
- `as any` type assertion
- `as unknown as SomeType` without proper narrowing
- Variable with `any` type
- Non-null assertion `!` without preceding null check

**Detection:**

```
- ❌ const x: any = value
- ❌ const y = x as unknown as string
- ❌ const z = maybeNull!
- ✅ if (maybeNull) { const z = maybeNull } // after guard
```

**Fix:** Use proper types, narrow with type guards, or use TypeScript assertion functions.

---

### 1.5 Import Path Consistency [WARNING]

**Rule:** Use consistent import patterns for same-layer imports.

**Violations:**

- Mixing relative paths with alias imports in same file
- Using `../../..` for long relative imports (use alias instead)
- Incorrect alias usage (`@app/` for schemas, relative for same-folder)

**Detection:**

```
File: apps/backend/src/routes/UserRoutes.ts (golden file)
- ✅ import UsersRepo from "@/repositories/UsersRepo"
- ✅ import * as Schemas from "@app/schemas"
- ❌ import UsersRepo from "../../routes/../repositories/UsersRepo" (verbose relative)
```

**Fix:** `@/` alias for backend layers, `@app/schemas` for cross-app schemas.

---

### 1.6 Database Schema Pattern [CRITICAL]

**Rule:** After ANY change to `apps/backend/src/db/tables.ts`, run `pnpm --filter backend db:generate` immediately and commit the migration with the schema change. Anything drizzle-kit can't express (RLS policies, partitions, extensions) goes in a custom SQL migration from `pnpm --filter backend db:generate:sql <name>`, in the same `src/db/migrations` journal. `halfvec` columns and HNSW indexes are declared in `tables.ts`. Every new migration folder also gets a hand-written `down.sql` that reverses it, run by `pnpm --filter backend db:rollback`.

**Violations:**

- Schema change in `apps/backend/src/db/tables.ts` without a new folder under `apps/backend/src/db/migrations/`
- Migration file missing or in a separate commit
- A hand-written migration folder or SQL file outside the drizzle-kit journal (not created by `db:generate:sql`). Exception: `down.sql` next to `migration.sql` in a journal folder
- A new migration folder without a `down.sql`, or a `down.sql` that doesn't reverse every statement of its `migration.sql`
- Editing an already-merged migration instead of adding a new one
- Schema change without the architecture diagram (`docs/architecture/companion-architecture-v0_15.excalidraw`) updated in the same PR [WARNING]

**Detection:**

```
PR contains changes to: apps/backend/src/db/tables.ts
But does NOT contain:
- A new apps/backend/src/db/migrations/<timestamp>_<name>/migration.sql + snapshot.json
- A change to docs/architecture/companion-architecture-v0_15.excalidraw
```

**Fix:** Run `pnpm --filter backend db:generate` (or `db:generate:sql <name>` for raw SQL), commit the generated folder with the schema change, and update the diagram.

---

### 1.7 File Placement [WARNING]

**Rule:** Files must live in correct folders per CLAUDE.md architecture.

**Violations:**

- DAL file in `repositories/` folder
- Repo file in `data-access-layer/` folder
- Route file not in `routes/` folder
- Frontend data file not prefixed with `-data.ts`
- Co-located components not prefixed with `-`

**Detection:**

```
- ❌ apps/backend/src/repositories/ChatbotsDAL.ts
- ✅ apps/backend/src/data-access-layer/ChatbotsDAL.ts

- ❌ apps/web/src/routes/_authenticated/chatbots/data.ts
- ✅ apps/web/src/routes/_authenticated/chatbots/-data.ts

- ❌ apps/web/src/routes/_authenticated/chatbots/ChatbotCard.tsx
- ✅ apps/web/src/routes/_authenticated/chatbots/-ChatbotCard.tsx
```

**Fix:** Move file to correct folder per CLAUDE.md structure.

---

### 1.8 Naming Conventions [WARNING]

**Rule:** Follow naming conventions per layer and language.

**Violations:**

- Class names not PascalCase (`chatbotsRepo` instead of `ChatbotsRepo`)
- Function names not camelCase (`GetChatbots` instead of `getChatbots`)
- Constants not SCREAMING_SNAKE_CASE (if not PascalCase)
- DAL method names inconsistent with pattern
- Repo method names inconsistent with pattern

**Detection:**

```
Database columns:
- ❌ userName (should be snake_case in DB)
- ✅ user_name (in DB), userData (in code)

TypeScript classes/functions:
- ❌ class chatbotsRepository
- ✅ class ChatbotsRepository

- ❌ function GetUserById
- ✅ function getUserById
```

**Fix:** Follow PascalCase for classes, camelCase for functions/variables, snake_case for DB columns.

---

### 1.9 Error Handling & Logging [CRITICAL]

**Rule:** Every DAL method must have try/catch with proper logging.

**Violations:**

- DAL method without try/catch block
- Error caught but not logged
- AppLogger call without required fields (category, action, message)
- Missing `response.isSuccess` flag initialization

**Detection:**

```
- ❌ async getChatbots(tx, params) { return await tx.select() }
- ✅ async getChatbots(tx, params) {
      const response = { isSuccess: false }
      try { ... response.isSuccess = true }
      catch (error) { AppLogger.error({ ... }) }
      return response
    }
```

**Fix:** Wrap in try/catch, initialize response, set success flag, log errors with context.

---

### 1.10 Mutation Error Handling [CRITICAL]

**Rule:** Every `useMutation` must have explicit `onError` handler.

**Violations:**

- `useMutation` without `onError` callback
- `onError` callback that is empty: `onError: () => {}`
- Error silently swallowed without user feedback

**Detection:**

```
File: apps/web/src/**/*.tsx
- ❌ useMutation({ mutationFn: ..., onSuccess: ... })
- ❌ useMutation({ mutationFn: ..., onError: () => {} })
- ✅ useMutation({
      mutationFn: ...,
      onError: (error) => { toast.error("Failed to...") }
    })
```

**Fix:** Add `onError` handler that shows user feedback via toast or error message.

---

### 1.11 Styling [WARNING]

**Rule:** Use Tailwind utilities only. No inline styles except for dynamic values impossible in Tailwind.

**Violations:**

- `style={{ marginTop: "16px" }}` (use Tailwind class instead)
- Inline styles for static values
- CSS modules in app folders
- styled-components usage

**Detection:**

```
- ❌ <div style={{ padding: "16px" }}>
- ✅ <div className="p-4">

- ❌ <div style={{ marginTop: gap }}>
- ✅ <div style={{ marginTop: `${gap}px` }}> (only if truly dynamic)
```

**Fix:** Replace static inline styles with Tailwind classes. Keep dynamic styles only when necessary.

---

## 2. CUSTOM RULES & PROJECT-SPECIFIC PATTERNS

### 2.1 Tailwind Hard-Coded Pixels [WARNING]

**Rule:** Never use arbitrary Tailwind values for spacing/sizing that exist in the design scale.

**Violations:**

- `px-[12px]`, `w-[200px]`, `h-[50px]`, `gap-[13px]` (should use standard scale)
- Hardcoded pixel values in Tailwind when standard class exists
- Color hex codes instead of Tailwind color scale

**Detection Pattern:**

```regex
className=.*(?:w|h|p|m|gap|px|py|pt|pb|pl|pr)\-\[\d+px\]
style=.*:\s*['"]?\d+px
className=.*\[\#[0-9A-Fa-f]{6}\]
```

**Examples:**

```
- ❌ <div className="px-[12px] w-[200px]">
- ✅ <div className="px-3 w-48">

- ❌ <div className="gap-[13px]">
- ✅ <div className="gap-3"> or <div className="gap-4">

- ❌ <div className="text-[#FF5733]">
- ✅ <div className="text-red-500">
```

**Spacing Scale Reference:**

```
2 (8px), 3 (12px), 4 (16px), 6 (24px), 8 (32px), 12 (48px), 16 (64px), 20 (80px), 24 (96px)
```

**Fix:** Use standard Tailwind spacing classes instead of arbitrary pixel values.

---

### 2.2 Theme Token Colours [WARNING]

**Rule:** Colours only through the theme tokens in `docs/design/tokens/theme.css` (exposed by `@app/ui/globals.css`) via Tailwind classes. No raw hex, no Tailwind palette colours. Lime (`primary`) is a fill only; lime text uses `brand-text`.

**Violations:**

- Hex, `rgb()`, `hsl()` or `oklch()` colours in classes, inline styles or component constants
- Arbitrary colour values `[#FF5733]`
- Tailwind palette colours (`bg-slate-900`, `text-red-500`, `border-gray-200`) instead of tokens
- `text-primary` for lime text

**Detection Pattern:**

```regex
\[\#[0-9A-Fa-f]{3,8}\]
style=.*color:\s*['"]?(#|rgb|hsl|oklch)
\b(bg|text|border|ring|fill|stroke|from|to|via)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b
\btext-primary\b
```

**Examples:**

```
- ❌ className="bg-[#1a1a1a]"
- ❌ className="bg-slate-900"
- ✅ className="bg-background" / className="bg-card"

- ❌ style={{ color: "#FF5733" }}
- ❌ className="text-red-500"
- ✅ className="text-destructive"

- ❌ className="text-primary"
- ✅ className="text-brand-text" (lime text) / className="bg-primary text-primary-foreground" (lime fill)
```

**Fix:** Use the matching token class from `docs/design/tokens/theme.css` (`bg-primary`, `text-brand-text`, `bg-diff-new`, …).

---

### 2.3 Type Scale [INFO]

**Rule:** Use the DESIGN.md §2 type scale from the preset (`text-page-title`, `text-metric`, `text-section`, `text-body`, `text-caption`, `text-mono-value`) over arbitrary sizes. `font-mono` only for machine values: record IDs, tool names, model names, config versions, keys.

**Violations:**

- `text-[13px]`, `text-[1.25rem]` and other arbitrary font sizes
- `font-mono` on labels, headings, prose or numbers that aren't machine values

**Detection Pattern:**

```regex
text-\[\d+(\.\d+)?(px|rem|em)\]
font-mono
```

**Examples:**

```
- ❌ <h1 className="text-[28px] font-semibold">Overview</h1>
- ✅ <h1 className="text-page-title">Overview</h1>

- ❌ <span className="font-mono">Chatbot settings</span>
- ✅ <span className="font-mono">{chatbot.publicId}</span>
```

**Fix:** Swap for the type-scale class; drop `font-mono` from non-machine values.

---

### 2.4 shadcn Components Untouched [CRITICAL]

**Rule:** shadcn components live in `packages/ui/src/components`, are added only with `pnpm --filter @app/ui exec shadcn add <name>`, and are never hand-edited. Apps use them as-is or via `className`.

**Violations:**

- Hand edits to an existing file in `packages/ui/src/components/` (anything other than a fresh `shadcn add`)
- A shadcn component copied into `apps/web` or `apps/widget`
- Importing from a path other than `@app/ui/components/<name>`; `cn` from anywhere other than `@app/ui/lib/utils`

**Detection:**

```
- ❌ Modified lines in packages/ui/src/components/button.tsx
- ❌ apps/web/src/components/ui/button.tsx
- ❌ import { Button } from "../../../packages/ui/src/components/button"
- ✅ import { Button } from "@app/ui/components/button"
- ✅ import { cn } from "@app/ui/lib/utils"
```

**Fix:** Revert the edit and style through `className` at the call site, or wrap the component in an app-level component.

---

### 2.5 Internal Names in UI Copy [WARNING]

**Rule:** Never show internal names in the UI. Copy follows `docs/design/DESIGN.md` §8.

**Violations:**

- User-facing strings containing `turn_id`, `change_requests`, `needs_human`, `company_id`, `publicId`, table or column names
- Raw enum values rendered as text instead of their label

**Examples:**

```
- ❌ <Badge>needs_human</Badge>
- ✅ <Badge>Needs review</Badge>   (wording per DESIGN.md §8)
```

**Fix:** Use the DESIGN.md §8 wording, or the `<feature>StatusLabel` from the API response.

---

### 2.6 Authenticated Routes Location [CRITICAL]

**Rule:** Any web route that needs user data lives under `apps/web/src/routes/_authenticated/`.

**Violations:**

- A route file outside `_authenticated/` that calls `useAuth()`, `apiClient`, or a `-data.ts` query
- `useAuth()` called below page level instead of at the page

**Detection:**

```
- ❌ apps/web/src/routes/chatbots/index.tsx (uses apiClient)
- ✅ apps/web/src/routes/_authenticated/chatbots/index.tsx
```

**Fix:** Move the route under `_authenticated/`.

---

## 3. COMPANION PLATFORM RULES

Rules from the dev plan's Architecture baseline and CLAUDE.md (Database, Runtime, Hard bans). Several need context beyond the diff: the enforcer may read the changed file and `apps/backend/src/db/tables.ts`, but flags only added or modified lines.

**Tenant table:** any table in `apps/backend/src/db/tables.ts` with a `companyId` column (all 30 tables since M1-1 except `companies`). `admins.company_id` and `eval_cases.company_id` are nullable (operator, platform case) and get their own RLS policies in M1-3. `companies` is the tenancy root and counts as tenant data when a tenant flow reads or writes it. Non-tenant tables today: `users`. Golden files: `apps/backend/src/db/withTenant.ts`, `ChatbotsDAL.ts`, `ChatbotsRepo.ts`.

### 3.1 Tenant Query Outside withTenant [CRITICAL]

**Rule:** Every query on a tenant table runs on the `tx` handed out by `withTenant(this.db, companyId, async (tx) => ...)`. The Repo opens the transaction; the DAL only receives `tx`. Nothing else opens a transaction on tenant data.

**Violations:**

- A Repo method calling a tenant DAL method outside a `withTenant` callback, or passing `this.db` where the DAL expects `tx`
- `.select()`, `.insert()`, `.update()`, `.delete()`, `.execute()` or `.query.*` on a tenant table through `this.db`, `db`, `getDbClient(env)` or a `drizzle(...)` instance instead of `tx`
- A tenant DAL holding `private db`, taking `env` in its constructor, or importing `getDbClient` / `drizzle`
- A tenant DAL method whose first parameter isn't `tx: NodePgTransaction<EmptyRelations>`
- `db.transaction(...)` anywhere except `apps/backend/src/db/withTenant.ts`
- Durable Objects, Queue consumers, Cron handlers, Workflows or routes touching tenant tables without going through a tenant Repo (which opens `withTenant`)
- A `tx` stored on a class field or module variable, or used after the `withTenant` callback returns
- A db client or `Pool` cached at module scope or on a long-lived object (Durable Object field) instead of built per request with `getDbClient(env)`

**Detection:**

```
File: apps/backend/src/repositories/*Repo.ts
- ❌ async getChatbots(params) {
       return await this.dal.getChatbots(this.db, params);
     }
- ❌ const rows = await this.db.select().from(chatbots).where(eq(chatbots.companyId, companyId));
- ✅ async getChatbots(params) {
       return await withTenant(this.db, params.companyId, async (tx) => {
         const result = await this.dal.getChatbots(tx, params);
         ...
       });
     }

File: apps/backend/src/data-access-layer/*DAL.ts (tenant table)
- ❌ export default class ChatbotsDAL {
       private db: NodePgDatabase;
       constructor(env: Env) { this.db = getDbClient(env); }
     }
- ❌ await this.db.update(chatbots).set({ ... })
- ✅ async updateChatbot(tx: NodePgTransaction<EmptyRelations>, params: Schemas.UpdateChatbotDALRequest) {
       ... await tx.update(chatbots).set({ ... }) ...
     }

Anywhere outside apps/backend/src/db/withTenant.ts
- ❌ await db.transaction(async (tx) => { ... chatbots ... })
```

**Fix:** Move the query into a tenant DAL method that takes `tx`, and call it from a Repo method inside `withTenant(this.db, companyId, async (tx) => ...)`. Mirror `ChatbotsRepo.getChatbots` / `ChatbotsDAL.getChatbots`.

---

### 3.2 RLS Context Per Transaction Only [CRITICAL]

**Rule:** `app.company_id` is set only by `withTenant`, with `set_config('app.company_id', …, true)` (transaction-local). Never per session: Hyperdrive pools connections, so session state leaks to the next request.

**Violations:**

- `set_config('app.company_id', …)` anywhere except `apps/backend/src/db/withTenant.ts`
- `set_config(…, false)` or a missing third argument
- `SET app.company_id`, `SET SESSION …`, `RESET`, or `SET ROLE` from application code
- Edits to `withTenant.ts` that set the context outside `db.transaction`, or change `true` to `false`

**Exemption:** test files under `apps/backend/src/tests/` may call `set_config('app.company_id', …, false)` only as a leak-detection control: on a throwaway single-connection pool, followed by nothing but a `current_setting` read, never before a query on a tenant table (see `withTenant.test.ts`).

**Detection Pattern:**

```regex
set_config\(
\bSET\s+(SESSION\s+)?(app\.|ROLE)
```

**Examples:**

```
- ❌ await db.execute(sql`set_config('app.company_id', ${companyId}, false)`)
- ❌ await db.execute(sql`SET app.company_id = ${companyId}`)
- ✅ withTenant(this.db, companyId, async (tx) => ...)   // sets it with `true` inside the transaction
- ✅ RLS policy in a custom SQL migration: USING (company_id = current_setting('app.company_id')::bigint)
```

**Fix:** Remove the call and run the query inside `withTenant`.

---

### 3.3 Tenant Key From the Server Only [CRITICAL]

**Rule:** `companyId` is the internal `companies.id`, resolved server-side (dashboard: the signed-in admin's company from M1-8; widget: the JWT issuer → `company_connections` row from M2-1). It is never read from a client, and every tenant DAL query filters on it as defence in depth on top of RLS.

**Violations:**

- `companyId` (or `company_id`) taken from `c.req.param()`, `c.req.query()`, `c.req.json()`, `c.req.valid(...)`, a WebSocket message, or a header
- A `*ApiRequest.ts` schema with a `companyId` / `company_id` field
- A tenant DAL `select` / `update` / `delete` whose `where` doesn't include `eq(<table>.companyId, params.companyId)`
- A tenant DAL `insert` that doesn't set `companyId` from params

**Examples:**

```
- ❌ const { companyId } = c.req.valid("json");
- ❌ export const CreateChatbotApiRequestSchema = z.object({ companyId: z.string(), ... })
- ❌ .where(eq(chatbots.publicId, params.publicId))
- ✅ .where(and(eq(chatbots.companyId, params.companyId), eq(chatbots.publicId, params.publicId)))
```

**Fix:** Resolve the company on the server from the authenticated identity, pass it to the Repo as `{ ...request, companyId }` (see `ChatbotsRepo.createChatbot`), and add the `companyId` filter.

---

### 3.4 Transactional Flows Roll Back [CRITICAL]

**Rule:** A Repo method that makes more than one write in one `withTenant` callback (outbox, action engine, set-default) must throw `TenantRollbackError(dalResponse.message)` when any DAL call fails, so earlier writes roll back. Plain single-write CRUD keeps the `{ isSuccess }` pattern.

**Violations:**

- Returning `{ isSuccess: false }` (or the failed DAL response) from a multi-write callback after an earlier write succeeded
- Catching and swallowing errors inside a `withTenant` callback
- Throwing a plain `Error` instead of `TenantRollbackError` (it surfaces as "Unknown error in tenant transaction")

**Examples:**

```
- ❌ const cleared = await this.dal.clearDefault(tx, params);
     const set = await this.dal.setDefault(tx, params);
     if (!set.isSuccess) return set;              // cleared stays committed
- ✅ if (!cleared.isSuccess) throw new TenantRollbackError(cleared.message);
     if (!set.isSuccess) throw new TenantRollbackError(set.message);
```

**Fix:** Mirror `ChatbotsRepo.setDefaultChatbot`.

---

### 3.5 Critical Events Need the Outbox [CRITICAL]

**Rule:** A critical event writes an `activity_log` row and an `event_outbox` row in the same `withTenant` transaction. The relay publishes outbox rows to the Queue; nothing sends a critical event to a Queue directly.

**Violations:**

- An `activity_log` insert without an `event_outbox` insert in the same `withTenant` callback (or the reverse)
- The two inserts in separate `withTenant` calls or separate Repo methods
- `env.<QUEUE>.send(...)` / `sendBatch(...)` for a critical event from a route, Repo or DO instead of the outbox relay
- A failed outbox write that doesn't throw `TenantRollbackError` (see 3.4)

**Examples:**

```
- ❌ await withTenant(this.db, companyId, (tx) => this.activityLogDAL.create(tx, event));
     await this.env.EVENTS_QUEUE.send(event);
- ✅ await withTenant(this.db, companyId, async (tx) => {
       const log = await this.activityLogDAL.create(tx, event);
       if (!log.isSuccess) throw new TenantRollbackError(log.message);
       const outbox = await this.eventOutboxDAL.create(tx, event);
       if (!outbox.isSuccess) throw new TenantRollbackError(outbox.message);
       return { isSuccess: true };
     });
```

**Fix:** Write both rows in one `withTenant` callback; let the relay publish.

---

### 3.6 Tenant Tables Ship With Isolation Tests [CRITICAL]

**Rule:** A PR that adds a tenant table, or a tenant Repo method, adds tests in `apps/backend/src/tests/` showing company B can't read or write company A's rows. From M1-3 these are RLS tests (non-owner app role). Tests clean up the rows they create.

**Violations:**

- New table with a `companyId` column in `tables.ts` and no new/changed `apps/backend/src/tests/*.test.ts`
- New tenant Repo method with no cross-company test
- Tests that insert rows without `afterAll` / `afterEach` cleanup

**Exception:** M1-1 creates the 28 M1 tables without DALs; it ships schema tests (`apps/backend/src/tests/migrations.test.ts`) instead. Each table's isolation tests arrive with its DAL + Repo (M1-4) and RLS policy (M1-3).

**Fix:** Mirror `apps/backend/src/tests/chatbots.test.ts`.

---

### 3.7 No Database Foreign Keys [CRITICAL]

**Rule:** No DB foreign keys. The DAL checks the referenced row exists before writing, and every reference column is indexed.

**Violations:**

- `.references(...)` or `foreignKey(...)` in `apps/backend/src/db/tables.ts`
- `REFERENCES` or `FOREIGN KEY` in a migration SQL file
- A reference column (`<thing>Id`, `<verb>By`) without a `t.index(...)` [WARNING]
- A DAL insert/update that sets a reference column without first checking the referenced row (see the company check in `ChatbotsDAL.createChatbot`)

**Detection Pattern:**

```regex
\.references\(
foreignKey\(
\bREFERENCES\b
FOREIGN KEY
```

**Fix:** Drop the FK, add an index on the column, and check the reference in the DAL.

---

### 3.8 Table Conventions [WARNING]

**Rule:** Tables follow CLAUDE.md › Database.

**Violations:**

- `id` that isn't `t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity()` [CRITICAL]. Exception: partitioned `activity_log`, whose primary key is `(id, created_at)`
- Missing `publicId` with a unique index `UNQ_<table>_public_id` [CRITICAL]. Exceptions: append-only/derived `activity_log`, `event_outbox`, `activity_rollups`, `eval_results`, `knowledge_chunks`; `admins` (`clerk_user_id`) and `chatbot_users` (`host_user_id`)
- `created_at` / `updated_at` not `t.timestamp(..., { withTimezone: true }).notNull().defaultNow()` (the append-only/derived tables above have no `updated_at`)
- An update DAL method that doesn't set `updatedAt`
- Status or type columns that aren't `t.smallint()`, or store strings
- Booleans not named `is_` / `has_` / `was_`; actor columns not `<verb>_by` (→ admins)
- `pgTable` not aliased as `table`; camelCase column names in the DB (must be `snake_case`)
- "bot" as the product word in new names or user-facing copy (use "chatbot")

**Fix:** Mirror the `chatbots` table in `tables.ts`.

---

### 3.9 Public ID and Status Enum Patterns [CRITICAL]

**Rule:** Internal ids never cross the API boundary; discrete states use the Status Enum Pattern.

**Violations:**

- A route param, query param or request body field that carries an internal `id` (anything not a `publicId`)
- An API response type that doesn't omit `id`, `companyId` and `<verb>By` (e.g. missing `Omit<Chatbot, "id" | "companyId" | "createdBy" | "updatedBy">`)
- A Repo that returns a DAL row to the route without stripping internal ids
- A DAL lookup by client input on `table.id` instead of `table.publicId`
- A status field without `<Feature>StatusIntEnum`, `<Feature>StatusLabelEnum` and `<FEATURE>_STATUS_LABEL_MAP` in `<Feature>Common.ts`
- An API response with `<feature>Status` but no `<feature>StatusLabel` (or the reverse)

**Examples:**

```
- ❌ app.get("/chatbots/:id", ...) → .where(eq(chatbots.id, params.id))
- ✅ app.get("/chatbots/:publicId", ...) → .where(and(eq(chatbots.companyId, ...), eq(chatbots.publicId, params.publicId)))
```

**Fix:** Mirror `ChatbotsCommon.ts`, `ChatbotsDAL.getChatbotDetails` and `ChatbotsRepo.withStatusLabel`.

---

### 3.10 Model Calls Only Through the Router [CRITICAL]

**Rule:** Every LLM call goes through the model router (M2-3) on the company's own key via AI Gateway. The only platform-paid model calls are Workers AI embeddings (`halfvec(1024)`) in knowledge ingestion and search.

**Violations:**

- Importing a provider SDK outside the model router: `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@google/generative-ai`, `@mistralai/*`, `cohere-ai`, `groq-sdk`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, or any other `@ai-sdk/<provider>`
- `fetch` to a provider API host (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, …) or to `gateway.ai.cloudflare.com` outside the router
- `env.AI.run(...)` with a non-embedding model, or anywhere except knowledge ingestion/search
- A Think `getModel()` that builds a provider client itself instead of asking the router
- A provider API key read from `env` (platform key) for a company's model call

**Detection Pattern:**

```regex
from\s+["'](openai|@anthropic-ai/sdk|@google/genai|@google/generative-ai|@mistralai/[^"']+|cohere-ai|groq-sdk|@ai-sdk/(?!react)[^"']+)["']
api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|gateway\.ai\.cloudflare\.com
env\.AI\.run\(
```

**Fix:** Call the model router; it decrypts the company key, sets AI Gateway metadata and handles the key-failure path.

---

### 3.11 Host Bearer Token Stays in DO Memory [CRITICAL]

**Rule:** The host bearer token lives only in Durable Object memory. Never log it, persist it, or send it anywhere except the host API call that needs it.

**Violations:**

- The token (`hostToken`, `bearerToken`, `accessToken`, an `Authorization` header value from the host) in `AppLogger` metadata, Sentry context/breadcrumbs, error messages, or `console.*`
- Writing it to `ctx.storage` / `this.ctx.storage.put`, `this.sql`, `this.setState(...)` (Agent/Think state is persisted), Think message history, KV, R2, D1, Queues, Neon, or `event_outbox` / `activity_log` payloads
- Returning it in a WebSocket message or HTTP response, or passing it to a model call / tool output the model can see
- Logging a whole request, headers object or tool-call context that contains it

**Examples:**

```
- ❌ AppLogger.info({ ..., metadata: { headers: request.headers } })
- ❌ await this.ctx.storage.put("hostToken", token)
- ❌ this.setState({ ...this.state, hostToken: token })
- ✅ this.hostToken = token;   // plain class field, lost on eviction → `token_needed` refreshes it
```

**Fix:** Keep it in a plain DO class field; on eviction the DO sends `token_needed` and the widget fetches a fresh one.

---

### 3.12 Versioned Shapes Need an Upgrader [CRITICAL]

**Rule:** The config spec and tool ops (`call_op`, `readback_op`, `inverse_op`) are Zod schemas in `packages/schemas`. Changing a shape bumps `schema_version` and adds an upgrader from the previous version in the same PR.

**Violations:**

- Adding, removing, renaming or retyping a field in a config spec or tool op schema without bumping `schema_version`
- A `schema_version` bump without an upgrader registered for the previous version, or without a test for it
- Config spec or tool op shapes defined outside `packages/schemas`

**Fix:** Bump `schema_version`, register the upgrader, and add an upgrade test.

---

### 3.13 Packages and Tooling [CRITICAL]

**Rule:** Only approved packages (CLAUDE.md › Stack); new dependencies need explicit approval; `pnpm` only; no inline ESLint disables.

**Violations:**

- Importing `react-hook-form` or `@hookform/resolvers` (installed drift; use `@tanstack/react-form`)
- An alternative to an approved package (another router, query lib, state lib, form lib, validator, icon set, ORM, logger, test runner)
- A new entry in any `package.json` `dependencies` / `devDependencies` without "approved by" in the PR description [WARNING]
- A package that duplicates a native browser or Workers API (e.g. `uuid` over `crypto.randomUUID()`, `node-fetch`/`axios` over `fetch`)
- `npm` / `npx` / `yarn` in `package.json` scripts, workflows or docs (`pnpm` / `pnpm dlx`)
- `// eslint-disable`, `/* eslint-disable */` or `eslint-disable-next-line` added without "approved by" in the PR description [WARNING]
- `drizzle-orm` / `drizzle-kit` moved off `1.0.0-rc.4`

**Detection Pattern:**

```regex
from\s+["'](react-hook-form|@hookform/resolvers)["']
eslint-disable
\b(npm|npx|yarn)\s
```

**Fix:** Use the approved package, ask before adding a dependency, and fix the lint error instead of disabling the rule.

---

### 3.14 Master Key Never Logged or Extractable [CRITICAL]

**Rule:** The envelope-encryption master key (M0-7, `apps/backend/src/providers/masterKey.ts`) is read only through `MasterKeyProvider.getMasterKey(env, version)`, which returns `{ isSuccess, message, masterKey? }` and never throws. The key comes back as a non-extractable `CryptoKey`; its raw bytes never appear in a log, an error message, or a response.

**Violations:**

- Reading `env.MASTER_KEY_V<n>` directly outside `MasterKeyProvider`
- `crypto.subtle.importKey(..., true, ...)` (extractable) for a master or company key, or `crypto.subtle.exportKey(...)` on one
- A master key, company key, or their raw/base64 bytes in `AppLogger` metadata, an error message, a thrown error, or a response body
- A provider or util outside `data-access-layer/` that throws instead of returning `{ isSuccess, message }`

**Detection Pattern:**

```regex
env\.MASTER_KEY_V\d+(?!.*masterKey\.ts)
importKey\([^)]*,\s*true\s*,
exportKey\(
```

**Examples:**

```
- ❌ const key = env.MASTER_KEY_V1; // outside masterKey.ts
- ❌ crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"])
- ❌ AppLogger.error({ ..., metadata: { masterKey } })
- ✅ const { isSuccess, masterKey, message } = await MasterKeyProvider.getMasterKey(env, version);
```

**Fix:** Go through `MasterKeyProvider`, keep `importKey` non-extractable, and never put key material in `metadata`.

---

## 4. ADDING NEW RULES

To add a new custom rule:

1. Add a new subsection under section 2 (UI and project-specific patterns) or section 3 (Companion platform rules). A new CLAUDE.md rule or hard ban gets a matching rule here in the same PR
2. Include these sections:
   - **Rule:** Clear one-liner (what is forbidden/required)
   - **Violations:** Specific bad patterns
   - **Detection Pattern:** Regex or exact string to search for (optional)
   - **Examples:** ❌ Bad code, ✅ Good code
   - **Fix:** How to correct it
   - Add severity tag: `[CRITICAL]`, `[WARNING]`, or `[INFO]`

**Example format:**

```markdown
### N.X Your New Rule [SEVERITY]

**Rule:** Clear description of what's enforced.

**Violations:**

- Specific violation 1
- Specific violation 2

**Detection Pattern:**
\`\`\`regex
pattern_here
\`\`\`

**Examples:**
\`\`\`

- ❌ Bad example
- ✅ Good example
  \`\`\`

**Fix:** How to correct it.
```

---

## 5. SEVERITY DEFINITIONS

| Level        | Meaning                                                     | Action                  | Symbol |
| ------------ | ----------------------------------------------------------- | ----------------------- | ------ |
| **CRITICAL** | Breaks architecture, type safety, or production safety      | Must fix before merge   | 🔴     |
| **WARNING**  | Inconsistent with standards but doesn't break functionality | Should fix before merge | 🟡     |
| **INFO**     | Best practice suggestion or minor improvement               | Nice to have            | 🔵     |

---

## 6. WORKFLOW INTEGRATION

The Pattern Enforcer workflow (`.github/workflows/claude-pr-review.yml`) runs on every PR that touches `apps/**` or `packages/**` TypeScript, migrations or a `package.json`, and automatically:

1. Reads this file on every PR
2. Checks every rule in sections 1–3 against the PR diff, flagging only added/modified lines (it may read a changed file and `tables.ts` for context, e.g. whether a query runs inside `withTenant`)
3. Posts inline comments for each violation with:
   - Severity level
   - Rule name
   - Exact location (file + line)
   - Current code snippet
   - Suggested fix with example
4. Posts a summary comment with violation counts by severity

### How to Update Rules

**Just edit this file** (`pattern-rules.md`). No workflow changes needed:

1. Add/modify rules in the sections above
2. Commit and push
3. Next PR will automatically use the updated rules

### Token Efficiency

- ✅ Only added/modified lines are flagged; full files are read only for context
- ✅ Rules file is read once per PR
- ✅ Pattern matching is efficient
- ✅ No full codebase scans required
- ⚠️ claude-code-action requires the workflow file in a PR to match `main`, so a PR that edits `claude-pr-review.yml` itself can't run the enforcer

---

## Last Updated

Created: 2025
Updated: 2026-10-04 (M0-6: section 3 Companion platform rules, UI rules 2.2–2.6; M0-7: 3.14 master key)
Maintainer: hatiprithwish
