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
- A provider (`apps/backend/src/providers/`) that calls a DAL without the caller's `tx`, opens `withTenant`/`withPlatform` itself, or builds a Drizzle query. Allowed: a provider calling a DAL with the Repo's `tx` when several Repos share the step (golden: `providers/companyKey.ts`), or when it holds one self-contained multi-DAL step a Repo runs inside its own transaction (`providers/criticalEvent.ts`, `providers/modelKeyFailure.ts`)
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

**Fix:** Route files should only import Repo. Repo imports DAL plus `getDbClient` / `withTenant` to open the transaction, and may call a provider that uses a DAL inside that transaction. Only the DAL builds queries.

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

**How a record goes out** (`providers/logger.ts`): one JSON object per record for Workers Logs. Every `Error` (and each `cause`) is reduced by `toLoggableError` to its name, message, stack and a short allowlist (`statusCode`, `failure`, `code`, `isRetryable`): an `APICallError`'s `requestBodyValues` / `responseBody` (the prompt, chat text included) or a `NoObjectGeneratedError`'s `text` never reach the log. Strings are redacted (`EMAIL_ADDRESS_PATTERN`) in the record before it is serialized, never on the serialized line (that breaks JSON escapes and drops the record). Don't add a payload field to the allowlist, and don't pass an error's payload as metadata.

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
File: apps/backend/src/routes/ChatbotsRoutes.ts (golden file)
- ✅ import ChatbotsRepo from "@/repositories/ChatbotsRepo"
- ✅ import * as Schemas from "@app/schemas"
- ❌ import ChatbotsRepo from "../../routes/../repositories/ChatbotsRepo" (verbose relative)
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

### 2.7 Dashboard Shell [WARNING]

**Rule:** Dashboard pages render inside the M4-1 shell (`_authenticated/route.tsx`), which reads `/dashboard/me` before any page and shows No access to a 403 or an operator. Navigation comes only from `_authenticated/-nav.ts` (sidebar and breadcrumb only map it; an item with `items`, like Settings, is a nested group); a new page adds its entry there and its route under `_authenticated/` (a nested group's pages under its `to`, e.g. `settings/`). `/dashboard/me` query keys carry the Clerk user. Every page opens with `PageHeader` (`@/components/page-header`). No bot switcher and no chatbot in a page path (DESIGN.md §6). `-data.ts` keeps keys and `queryOptions` in its `Queries` class and the hooks as plain exported functions.

**Violations:**

- A page that builds its own sidebar, top bar or `<h1>` header instead of `PageHeader`
- A nav link or breadcrumb label hard-coded outside `-nav.ts`
- Sidebar or breadcrumb code that places an item by matching a label (`group.label === "Admin"`)
- A query key for per-user data without the Clerk user id
- A second `/dashboard/me` read outside `useMe`
- A bot switcher, or a `$botId` segment in a dashboard route
- A hook (`useQuery`, `useAuth`) inside a `Queries` class

**Detection:**

```
- ❌ apps/web/src/routes/_authenticated/changes/index.tsx: <h1 className="text-page-title">Changes</h1>
- ❌ apps/web/src/routes/_authenticated/$botId/overview/index.tsx
- ✅ <PageHeader title="Changes" description="…" />
- ✅ export function useMe() { return useQuery({ ...MeQueries.detail(getToken), … }) }
```

**Fix:** Render the page through `PageHeader`, add its link to `-nav.ts`, take the bot as an optional `botId` query param.

---

## 3. COMPANION PLATFORM RULES

Rules from the dev plan's Architecture baseline and CLAUDE.md (Database, Runtime, Hard bans). Several need context beyond the diff: the enforcer may read the changed file and `apps/backend/src/db/tables.ts`, but flags only added or modified lines.

**Tenant table:** any table in `apps/backend/src/db/tables.ts` with a `companyId` column (all 30 tables since M1-1 except `companies`, plus `admin_invites` from M4-10). `admins.company_id` and `eval_cases.company_id` are nullable (operator, platform case); tenants never match those rows, and tenants may read platform eval cases but not write them (`*_rls_policies` migration). `companies` is the tenancy root and counts as tenant data when a tenant flow reads or writes it. Non-tenant tables today: none (the scaffold `users` table was dropped in M1-8). Golden files: `apps/backend/src/db/withTenant.ts`, `apps/backend/src/db/withPlatform.ts`, `ChatbotsDAL.ts`, `ChatbotsRepo.ts`.

**RLS (M1-3):** the worker connects as `diletta_app`, which can't bypass RLS. Every tenant table and `companies` has RLS enabled and forced, with a tenant policy (`company_id` = `app.company_id`) and a platform policy (`app.is_platform` = `on`). The owner role (`DATABASE_URL`) is for migrations and test fixtures only. See `docs/runbooks/app-role.md`.

### 3.1 Tenant Query Outside withTenant [CRITICAL]

**Rule:** Every query on a tenant table runs on the `tx` handed out by `withTenant(this.db, companyId, async (tx) => ...)`, or by `withPlatform(this.db, async (tx) => ...)` where 3.15 allows it. The Repo opens the transaction; the DAL only receives `tx`. Nothing else opens a transaction on tenant data.

**Violations:**

- A Repo method calling a tenant DAL method outside a `withTenant` callback, or passing `this.db` where the DAL expects `tx`
- `.select()`, `.insert()`, `.update()`, `.delete()`, `.execute()` or `.query.*` on a tenant table through `this.db`, `db`, `getDbClient(env)` or a `drizzle(...)` instance instead of `tx`
- A tenant DAL holding `private db`, taking `env` in its constructor, or importing `getDbClient` / `drizzle`
- A tenant DAL method whose first parameter isn't `tx: NodePgTransaction<EmptyRelations>`
- `db.transaction(...)` anywhere except `apps/backend/src/db/withTenant.ts` and `apps/backend/src/db/withPlatform.ts`
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

**Rule:** `app.company_id` is set only by `withTenant`, with `set_config('app.company_id', …, true)`, and `app.is_platform` only by `withPlatform`, with `set_config('app.is_platform', 'on', true)`. Both are transaction-local. Never per session: Hyperdrive pools connections, so session state leaks to the next request.

**Violations:**

- `set_config('app.company_id', …)` anywhere except `apps/backend/src/db/withTenant.ts`
- `set_config('app.is_platform', …)` anywhere except `apps/backend/src/db/withPlatform.ts`
- `set_config(…, false)` or a missing third argument
- `SET app.company_id`, `SET SESSION …`, `RESET`, or `SET ROLE` from application code
- Edits to `withTenant.ts` or `withPlatform.ts` that set the context outside `db.transaction`, or change `true` to `false`

**Exemption:** test files under `apps/backend/src/tests/` may call `set_config('app.company_id', …, false)` only as a leak-detection control: on a throwaway single-connection pool over the direct connection string (never `NEON_POOLER_URL`), followed by nothing but a `current_setting` read, never before a query on a tenant table, and with `RESET app.company_id` in a `finally` before the pool ends. `pool.end()` alone doesn't clear the server session if a pooler sits in between (see `withTenant.test.ts`).

**Detection Pattern:**

```regex
set_config\(
\bSET\s+(SESSION\s+)?(app\.|ROLE)
```

```
File: any file except apps/backend/src/db/withTenant.ts, apps/backend/src/db/withPlatform.ts and apps/backend/src/tests/*.test.ts → flag every match
File: apps/backend/src/tests/*.test.ts → a set_config(…, false) match passes only if it meets every condition of the exemption above; flag it otherwise
```

**Examples:**

```
- ❌ await db.execute(sql`set_config('app.company_id', ${companyId}, false)`)
- ❌ await db.execute(sql`SET app.company_id = ${companyId}`)
- ✅ withTenant(this.db, companyId, async (tx) => ...)   // sets it with `true` inside the transaction
- ✅ withPlatform(this.db, async (tx) => ...)               // sets app.is_platform with `true` inside the transaction
- ✅ RLS policy in a custom SQL migration: USING ("company_id" = (SELECT NULLIF(current_setting('app.company_id', true), '')::bigint))
```

**Fix:** Remove the call and run the query inside `withTenant` (or `withPlatform` where 3.15 allows it).

---

### 3.3 Tenant Key From the Server Only [CRITICAL]

**Rule:** `companyId` is the internal `companies.id`, resolved server-side (dashboard: `c.get("companyId")`, set by `authorizeCompany` from the signed-in admin; widget: the verified JWT's issuer → `company_connections` row in `WidgetAuthRepo.authenticate`). It is never read from a client, and every tenant DAL query filters on it as defence in depth on top of RLS.

**Violations:**

- `companyId` (or `company_id`) taken from `c.req.param()`, `c.req.query()`, `c.req.json()`, `c.req.valid(...)`, a WebSocket message, or a header
- A `*ApiRequest.ts` schema with a `companyId` / `company_id` field
- A tenant DAL `select` / `update` / `delete` whose `where` doesn't include `eq(<table>.companyId, params.companyId)`, except the pre-tenant lookups that resolve the company in `withPlatform` (rule 3.15): `AdminsDAL.getAdminByClerkUserId`, `CompaniesDAL.getCompanyByPublicId` and `CompanyConnectionsDAL.getCompanyConnectionByIssuer`
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

**Rule:** A critical event writes an `activity_log` row and an `event_outbox` row in the same `withTenant` transaction, through `CriticalEventProvider.record(tx, …)` (golden: `providers/criticalEvent.ts`). The relay (`EventOutboxRepo.relayEvents` in `waitUntil` after commit, plus the Cron sweep) publishes outbox rows to the Queue; nothing sends a critical event to a Queue directly. Delivery is at-least-once, so consumers dedupe on `outboxId`.

**Violations:**

- An `activity_log` insert without an `event_outbox` insert in the same `withTenant` callback (or the reverse)
- The two inserts in separate `withTenant` calls or separate Repo methods
- `env.<QUEUE>.send(...)` / `sendBatch(...)` for a critical event from a route, Repo or DO instead of the outbox relay
- A failed outbox write that doesn't throw `TenantRollbackError` (see 3.4)
- `ActivityLogDAL` / `EventOutboxDAL` called from a Repo, DO, Cron or consumer instead of `CriticalEventProvider` / `EventOutboxRepo`
- `relayEvents` called inside the writer's `withTenant` callback (before commit) instead of in `waitUntil` after it
- A Queue consumer that retries a whole batch (`retryAll`, or throwing from `queue()`) instead of acking or retrying per message, or a handler with side effects that doesn't dedupe on `outboxId`

**Examples:**

```
- ❌ await withTenant(this.db, companyId, (tx) => this.activityLogDAL.create(tx, event));
     await this.env.EVENTS_QUEUE.send(event);
- ✅ const result = await withTenant(this.db, companyId, async (tx) => {
       const change = await this.dal.updateChangeRequest(tx, params);
       if (!change.isSuccess) throw new TenantRollbackError(change.message);
       const recorded = await CriticalEventProvider.record(tx, { companyId, ...criticalEvent });
       if (!recorded.isSuccess) throw new TenantRollbackError(recorded.message);
       return { ...change, outboxId: recorded.outboxId };
     });
     // route / DO, after the commit:
     ctx.waitUntil(new EventOutboxRepo(env).relayEvents({ companyId, outboxIds: [result.outboxId] }));
```

**Fix:** Call `CriticalEventProvider.record` in the change's `withTenant` callback; relay the `outboxId` in `waitUntil` after commit.

---

### 3.6 Tenant Tables Ship With Isolation Tests [CRITICAL]

**Rule:** A PR that adds a tenant table, or a tenant Repo method, adds tests in `apps/backend/src/tests/` showing company B can't read or write company A's rows. These are RLS tests: the code under test runs as `diletta_app` (the `HYPERDRIVE` binding), and only fixtures and cleanup use the owner connection (`DATABASE_URL` test binding). A new tenant table gets a `FIXTURES` entry in `rls.test.ts`; its catalog test fails until it has one. Tests clean up the rows they create.

**Violations:**

- New table with a `companyId` column in `tables.ts` and no `FIXTURES` entry in `apps/backend/src/tests/rls.test.ts`
- New tenant Repo method with no cross-company test
- Code under test (Repo, DAL, `withTenant`, `withPlatform`) run on the owner connection, which bypasses RLS and proves nothing
- Tests that insert rows without `afterAll` / `afterEach` cleanup

**Fix:** Mirror `apps/backend/src/tests/rls.test.ts` (table policies) and `apps/backend/src/tests/chatbots.test.ts` (Repo methods).

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

**Rule:** Every LLM call goes through the model router on the company's own key via AI Gateway: `ModelRouterRepo.getModel` (`repositories/ModelRouterRepo.ts`), which builds the model only through `AiGatewayProvider` (`providers/aiGateway.ts`). The model it returns is wrapped to write one `model_calls` row per call, priced from `MODEL_PRICES`; a model missing from that table is refused, never priced at 0. Usage-status rules live only in `ModelCallRecordingProvider`: a call billed without usage (stream cut or cancelled, connection lost, a finish without totals, an unreadable 2xx) is written `usage_status` Pending for the Cron backfill, never Reported at $0; only a 4xx/5xx refusal is Reported at 0. Every model failure reaches the caller as `ModelUnavailableError` (an abort stays an abort): Think sends a stream error's message to the widget verbatim. Only a provider's own rejected-key answer (`AiGatewayProvider.isRejectedKeyError`: 401 / Google `API_KEY_INVALID`, never a 403 or a gateway error) may mark a company key Invalid, and only through `CompanySecretsDAL.invalidateModelKey`, which checks the row still holds the value used. The only platform-paid model calls are Workers AI embeddings (`halfvec(1024)`) in knowledge ingestion and search, and the search reranker: `env.AI.run` only in `providers/knowledgeEmbed.ts` (bge-m3, `KNOWLEDGE_EMBEDDING_MODEL`) and `providers/knowledgeRerank.ts` (`KNOWLEDGE_RERANK_MODEL`), `env.AI.toMarkdown` only in `providers/knowledgeExtract.ts` (HTML, PDF, DOCX; never an image, which would run a model). Each of these calls gets its `model_calls` row through `KnowledgeModelCallsProvider` (tier Embed, provider `workers_ai`, usage `Estimated`, priced from `PLATFORM_MODEL_PRICES` rounded up), left out of the company budget seed.

**Violations:**

- Importing a provider SDK anywhere but `providers/aiGateway.ts`: `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@google/generative-ai`, `@mistralai/*`, `cohere-ai`, `groq-sdk`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, or any other `@ai-sdk/<provider>`
- `fetch` to a provider API host (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, …) or to `gateway.ai.cloudflare.com` outside `providers/aiGateway.ts`
- A model call that skips the router's middleware (no `model_calls` row), or a cost computed outside `computeModelCallCostUsd`
- A fallback price (0 or a default) for a model missing from `MODEL_PRICES`
- Letting a provider or gateway error (or its message) out of a routed model's call unwrapped, or deciding a usage status outside `ModelCallRecordingProvider`
- Wrapping a retryable answer before retrying it (the SDK won't retry a wrapped error), or a retry without a cap, backoff or abort
- Deciding which providers a system issue covers from its note text instead of its activity events
- Marking a key Invalid, or opening a system issue, on any status code without matching the provider's error shape, on a 403, or through the general `updateCompanySecret` (it would invalidate a key the admin replaced meanwhile)
- Writing a `model_calls` row as Reported with zero usage for a call that reached the provider without a refusal (use Pending with the gateway log id, or Unknown)
- Logging the decrypted company key or the gateway token, or passing either anywhere but the provider SDK settings
- `env.AI.run(...)` with a model other than the embedding or rerank model, or anywhere but `providers/knowledgeEmbed.ts` / `providers/knowledgeRerank.ts`; `env.AI.toMarkdown(...)` anywhere but `providers/knowledgeExtract.ts`, or on an image
- An embed call with no `model_calls` row, or one written at $0 (price it with `computeModelCallCostUsd(…, true)`)
- A Think `getModel()` that builds a provider client itself instead of asking the router
- A provider API key read from `env` (platform key) for a company's model call

**Detection Pattern:**

```regex
from\s+["'](openai|@anthropic-ai/sdk|@google/genai|@google/generative-ai|@mistralai/[^"']+|cohere-ai|groq-sdk|@ai-sdk/(?!react)[^"']+)["']
api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|gateway\.ai\.cloudflare\.com
env\.AI\.(run|toMarkdown)\(
```

**Examples:**

```
- ❌ import { createAnthropic } from "@ai-sdk/anthropic"; // in a DO or a Repo
- ❌ getModel() { return createOpenAI({ apiKey: env.OPENAI_KEY })("gpt-6-sol"); }
- ❌ const cost = MODEL_PRICES[provider][model]?.inputUsdPerMTok ?? 0;
- ✅ const routed = await new ModelRouterRepo(env, ctx).getModel({ companyId, …, routing: spec.routing });
```

**Fix:** Call `ModelRouterRepo.getModel`; it prices the model, decrypts the company key, sets AI Gateway metadata, records `model_calls` and handles the key-failure path (`docs/runbooks/ai-gateway.md`).

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
- Editing a released `ZConfigSpecV<n>` instead of adding `ZConfigSpecV<n+1>` (the stored rows at version n still parse with it)
- Parsing a `chatbot_configs.body` with `ZConfigSpec*.parse` / `safeParse` outside `packages/schemas` instead of `loadConfigSpec` (read) or `normalizeConfigBody` (write); the first skips the upgrade from the row's `schema_version`
- Writing a `loadConfigSpec` result (`spec`) back to `chatbot_configs.body` instead of `normalizeConfigBody`'s `body`: it freezes today's platform defaults into the row
- `.default()` / `.prefault()` in a versioned `ZConfigSpecV<n>`: platform defaults go in `ConfigSpecDefaults.ts`, applied on load only
- A change to a schema in `JSON_SCHEMA_EXPORTS` (`packages/schemas/src/jsonSchemaExports.ts`) without the regenerated `evals/schemas/*.json` in the same PR, or a hand edit to a file in `evals/schemas/`

**Fix:** Bump `schema_version`, register the upgrader, and add an upgrade test. Run `pnpm --filter @app/schemas schema:export` and `pnpm evals:types`, and commit `evals/schemas/`, `evals/fixtures/` and `evals/diletta_evals/types/`.

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

### 3.15 withPlatform Only for Cross-Company Work [CRITICAL]

**Rule:** `withPlatform` passes every RLS policy, so it reads and writes every company's rows. It is allowed only where no single company applies: operator routes (`/operator/*`, operator-only actions behind `can()`), Cron or Queue jobs that sweep across companies (outbox relay sweep, rollups, retention purge, nightly platform suite), and the lookups that resolve the company before `withTenant` can run (Clerk admin → company, JWT issuer → `company_connections` row, eval JWT `company` claim → company). Anything scoped to one company uses `withTenant`, even when an operator triggers it.

**Violations:**

- `withPlatform` in a widget route, a dashboard route serving a company admin, or a Conversation DO turn
- A pre-tenant lookup that, inside its `withPlatform` callback, reads or writes anything beyond the one row that resolves the company
- `withPlatform` used to edit one known company's data instead of `withTenant(this.db, companyId, …)`
- A DAL importing `withPlatform` (the Repo opens the transaction, as in 3.1)

**Detection Pattern:**

```regex
withPlatform\(
```

**Examples:**

```
- ❌ // dashboard route for a company admin
     await withPlatform(this.db, (tx) => this.dal.getChatbots(tx, { companyId }));
- ✅ await withTenant(this.db, companyId, (tx) => this.dal.getChatbots(tx, { companyId }));
- ✅ // Cron: outbox relay sweep across companies
     await withPlatform(this.db, (tx) => this.dal.getPendingEvents(tx, { limit }));
```

**Fix:** Resolve the company first and use `withTenant`. Keep `withPlatform` callbacks to the cross-company query itself.

---

### 3.16 New Tables Granted and Protected in Their Migration [CRITICAL]

**Rule:** `diletta_app` has no default privileges. A PR that adds a table to `tables.ts` also adds a custom SQL migration (`db:generate:sql`) that grants it to `diletta_app` by name, and for a tenant table enables and forces RLS with a tenant policy and a platform policy, mirroring `*_rls_policies`. Its `down.sql` reverses all of it.

**Violations:**

- A new table with no `GRANT … ON "<table>" TO diletta_app`
- A new tenant table without `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` and both policies
- `GRANT … ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES`, or a grant on an `activity_log_*` partition
- A policy that casts `current_setting('app.company_id')` without `NULLIF(…, '')` (a reset setting reads `''` and fails the cast)
- Granting `diletta_app` `BYPASSRLS`, `SUPERUSER`, `CREATEROLE`, `neon_superuser`, or table ownership

**Examples:**

```
- ❌ ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO diletta_app;
- ✅ GRANT SELECT, INSERT, UPDATE, DELETE ON "new_table" TO diletta_app;
     ALTER TABLE "new_table" ENABLE ROW LEVEL SECURITY;
     ALTER TABLE "new_table" FORCE ROW LEVEL SECURITY;
     CREATE POLICY "POL_new_table_tenant" ON "new_table" FOR ALL TO diletta_app USING (…) WITH CHECK (…);
     CREATE POLICY "POL_new_table_platform" ON "new_table" FOR ALL TO diletta_app USING (…) WITH CHECK (…);
```

**Fix:** Copy one table's block from `apps/backend/src/db/migrations/*_rls_policies/migration.sql` and its `down.sql`.

---

### 3.17 Paged Lists [WARNING]

**Rule:** A DAL list over rows that grow without bound (chatbot users, conversations, messages, companies…) is paged as in CLAUDE.md › Conventions › Pagination. Golden: `ChatbotUsersDAL.getChatbotUsers` / `getChatbotUsersCount`.

**Violations:**

- A list method on a growing table with no `.limit(…)`, or a request schema that doesn't extend `ZPageApiRequest`
- `pageSize` not capped by `MAX_PAGE_SIZE`; defaults set in the DAL instead of the Repo
- An `orderBy` without the trailing `asc(<table>.id)` tie-break (rows repeat or vanish between pages)
- Keyset/cursor pagination, or a total count computed in the list query

**Examples:**

```
- ❌ await tx.select().from(conversations).where(eq(conversations.companyId, params.companyId));
- ✅ .orderBy(orderExpr, asc(conversations.id)).limit(params.pageSize).offset((params.pageNo - 1) * params.pageSize)
```

**Fix:** Mirror `ChatbotUsersDAL.getChatbotUsers` and add a `get<Feature>Count` method.

---

### 3.18 Where Clauses [INFO]

**Rule:** One condition: `.where(eq(…))`. Two or more: a `conditions` array built before the query (optional ones pushed with `if`), then `.where(and(...conditions))`, the same shape for select, update and delete. Golden: `ChatbotsDAL.ts`.

**Violations:**

- Inline `.where(and(eq(…), eq(…)))`
- `.where(() => { … })` callback (drizzle `1.0.0-rc.4` accepts it on select only, so update/delete would differ)
- Optional filters written as inline ternaries (`x ? eq(…) : undefined`)

**Examples:**

```
- ❌ .where(and(eq(chatbots.publicId, params.publicId), eq(chatbots.companyId, params.companyId)))
- ✅ const conditions = [eq(chatbots.publicId, params.publicId), eq(chatbots.companyId, params.companyId)];
     if (params.status !== null) conditions.push(eq(chatbots.status, params.status));
     … .where(and(...conditions))
```

**Fix:** Move the conditions into an array before the query.

---

### 3.19 Envelope Encryption Through @app/crypto [CRITICAL]

**Rule:** `encrypted_*` columns are written and read only through `CompanyKeyProvider.encryptValue` / `decryptValue` (`apps/backend/src/providers/companyKey.ts`), which use `@app/crypto` (`packages/crypto`). Company keys are created only by `CompanyKeyProvider.createCompanyKey` and rotated only by `CompanyEncryptionKeysRepo.rotateCompanyEncryptionKey`. The Repo encrypts before the DAL: plaintext never reaches a DAL param, a log or a route response, and the row stores `iv` + `encryption_key_version` next to the ciphertext.

**Violations:**

- `crypto.subtle.encrypt` / `decrypt` / `importKey` on company data outside `packages/crypto` (`masterKey.ts` imports the master key only)
- A DAL request type or DAL param carrying a plaintext secret, or a DAL writing `encrypted_*` without `iv` and `encryption_key_version`
- Decrypting with the active key instead of the row's `encryption_key_version`
- A `getDecrypted*` / `Decrypted*Response` returned from a route, or an API response type that keeps `encrypted*`, `iv` or `encryptionKeyVersion`
- `encryptedSecret`, `encryptedKey`, `iv`, a plaintext secret or a `CryptoKey` in `AppLogger` metadata (strip them: `const { encryptedSecret: _e, iv: _iv, ...metadata } = params`)
- A new encrypted column without an `EncryptedColumnEnum` entry (its value is the AES-GCM additional data; changing an existing value breaks every stored ciphertext)
- `packages/crypto` importing a logger, a DB client or `env`, or throwing instead of returning `{ isSuccess, message }`

**Detection Pattern:**

```regex
crypto\.subtle\.(encrypt|decrypt)\((?!.*packages/crypto)
metadata:\s*\{[^}]*\b(encryptedSecret|encryptedKey|iv|plaintext)\b
```

**Examples:**

```
- ❌ await crypto.subtle.encrypt({ name: "AES-GCM", iv }, companyKey, data); // in a Repo
- ❌ await this.dal.createCompanySecret(tx, { ..., secret: params.companySecret.secret });
- ❌ return c.json(await repo.getDecryptedCompanySecret(params), 200);
- ✅ const encrypted = await CompanyKeyProvider.encryptValue(this.env, tx, { companyId, column, plaintext });
     await this.dal.createCompanySecret(tx, { ..., encryptedSecret: encrypted.encryptedValue.ciphertext,
       iv: encrypted.encryptedValue.iv, encryptionKeyVersion: encrypted.encryptionKeyVersion });
```

**Fix:** Mirror `CompanySecretsRepo`: encrypt through `CompanyKeyProvider` in the Repo's transaction, pass only ciphertext to the DAL, decrypt with the row's version, and keep `getDecrypted*` server-side.

---

### 3.20 Every Dashboard and Operator Route Behind can() [CRITICAL]

**Rule:** Every `/dashboard/*` and `/operator/*` handler runs `checkAuth`, then `authorizeCompany(action)` (company routes) or `authorizePlatform(action)` (operator routes), then `zValidator`. Those middlewares are the one `can(admin, action, resource)` check (`packages/schemas/src/authz/`). Each action is an `AuthzActionEnum` value; one a company admin must never perform is also in `OPERATOR_ONLY_ACTIONS`. The only exception is `GET /dashboard/me`, the sign-in check that provisions a company admin. Roles are derived from `admins.company_id` (NULL = operator); app code never creates an admin without a company. Operators are added by hand (`docs/runbooks/operators.md`).

**Violations:**

- A route in `apps/backend/src/routes/` mounted under `/dashboard` or `/operator` with no `authorizeCompany(` / `authorizePlatform(` in its chain (other than `GET /dashboard/me`)
- `zValidator` before the authorize middleware (an unauthorized call would get 400 instead of 403)
- An operator-only action (company create/list, tool manifest edits…) behind `authorizeCompany`, or missing from `OPERATOR_ONLY_ACTIONS`
- A role check written by hand (`admin.companyId === null`, `role === "operator"`) in a route or Repo instead of `can()`; the role is derived once, in `AdminsRepo.toContext`
- A route mapping every `isSuccess: false` to 404 instead of `isSuccess ? 200 : isNotFound ? 404 : 500`
- A string literal action instead of `Schemas.AuthzActionEnum.*`
- An `admins` insert with `companyId: null` (or no `companyId`) outside tests and the runbook
- A role column added to `admins`

**Detection Pattern:**

```regex
(Routes\.(get|post|put|patch|delete)\()|(\.insert\(admins\))
```

**Examples:**

```
- ❌ ChatbotsRoutes.get("/", checkAuth, async (c) => …)
- ❌ ChatbotsRoutes.post("/", checkAuth, zValidator("json", …), authorizeCompany(…), …)
- ❌ if (c.get("admin").role !== Schemas.AdminRoleEnum.Operator) return c.json(…, 403);
- ✅ ChatbotsRoutes.post("/", checkAuth, authorizeCompany(Schemas.AuthzActionEnum.ChatbotCreate),
       zValidator("json", Schemas.ZCreateChatbotApiRequest), async (c) => …)
- ✅ CompaniesRoutes.get("/", checkAuth, authorizePlatform(Schemas.AuthzActionEnum.CompanyList), …)
```

**Fix:** Add the action to `AuthzActionEnum` (and `OPERATOR_ONLY_ACTIONS` if needed), then put the matching authorize middleware straight after `checkAuth`. Golden: `ChatbotsRoutes.ts` (company), `CompaniesRoutes.ts` (operator).

---

### 3.21 Owner Rights Only Through SECURITY DEFINER Functions [CRITICAL]

**Rule:** `diletta_app` never runs DDL and the worker never holds an owner connection string. When the worker needs an owner action (today: `activity_log` partitions, M1-9), a custom SQL migration adds a `SECURITY DEFINER` function, owned by the owner role, that does one fixed thing and validates its arguments. It sets `search_path = pg_catalog, public, pg_temp` (and `timezone` when it does date arithmetic), is `REVOKE`d from `PUBLIC`, and grants `EXECUTE` to `diletta_app` only. Its `down.sql` drops it. The DAL calls it inside the Repo's transaction like any other query.

**Violations:**

- `GRANT CREATE`, table ownership or membership in the owner role for `diletta_app`
- A second database URL with the owner role in `wrangler.jsonc`, a secret, or `Env`
- A `SECURITY DEFINER` function with no `SET search_path`, or one that includes a user-writable schema ahead of `pg_catalog`
- A `SECURITY DEFINER` function without `REVOKE ALL ON FUNCTION … FROM PUBLIC`, or granted to any role other than `diletta_app`
- A function that runs caller-supplied SQL or table names (`EXECUTE` built from an argument without `format('%I' / '%L')` and a whitelist), or returns row data the app's grants wouldn't let it read
- A grant on an `activity_log_*` partition (the app reaches them only through `activity_log`)

**Detection Pattern:**

```regex
SECURITY DEFINER|GRANT CREATE|OWNER TO diletta_app
```

**Examples:**

```
- ❌ GRANT CREATE ON SCHEMA public TO diletta_app;
- ❌ CREATE FUNCTION run_ddl(p_sql text) … SECURITY DEFINER AS $$ BEGIN EXECUTE p_sql; END $$;
- ✅ CREATE FUNCTION "create_activity_log_partition"("p_month_start" timestamptz) … SECURITY DEFINER
       SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$ … $$;
     REVOKE ALL ON FUNCTION "create_activity_log_partition"(timestamptz) FROM PUBLIC;
     GRANT EXECUTE ON FUNCTION "create_activity_log_partition"(timestamptz) TO diletta_app;
```

**Fix:** Mirror `apps/backend/src/db/migrations/*_activity_log_partition_maintenance/`. Test the grants, the argument checks and that `diletta_app` still can't run the DDL itself (`activityLogPartitions.test.ts`).

---

### 3.22 Widget Identity Only From a Verified Companion JWT [CRITICAL]

**Rule:** The widget authenticates before the WebSocket upgrade (ADR 0001): the companion JWT rides in `Sec-WebSocket-Protocol` as `['diletta.v1', <jwt>]` (never in a URL or query param), and `GET /widget/ws` answers with an HTTP status before any socket exists. `WidgetAuthRepo.authenticate` is the only way to a `WidgetIdentity`, in this order: decode with the algorithm allowlist (`WidgetJwtAlgorithmEnum`: RS256, ES256; `kid` required; `crit` rejected) → issuer → `company_connections` row (`withPlatform`) → signature against the issuer's JWKS through `JwksProvider` (KV-cached, fetched only for a registered issuer, body capped in bytes while streaming) → `aud = WIDGET_JWT_AUDIENCE`, `exp`, `nbf`, `iat`, lifetime ≤ 5 min → connection active and `Origin` in its `allowed_origins` → company active and the chatbot active, in `withTenant`. Every failure before the signature and claims pass is `Unauthorized` (401), so the status never tells an unsigned token whether an issuer is registered or an origin allowed. Claims are validated, never transformed (no `.trim()` on `sub`). The identity carries internal ids and stays server-side; the upgrade is forwarded to the Conversation DO only after `ConversationsRepo.startOrResume`, with a fresh header set the route builds itself. The response selects `diletta.v1` only; the token is never echoed, logged or stored. `GET /widget/bootstrap` (M2-7, ADR 0002) is the one other route that takes the token: as `Authorization: Bearer` only, through the same `authenticate`, with the same statuses and generic bodies, read-only (no chatbot user, conversation or event). The bearer scheme matches in any case. On both routes the query is validated only after `authenticate` (never a `zValidator` before it), so a request without a valid token is 401 whatever its query, and only a verified token sees 400. `/widget/*` CORS is set by `WidgetRoutes` (never the dashboard's credentialed allowlist): any origin, `credentials: false`, only the `Authorization` header.

**Violations:**

- Reading the companion JWT from a URL or query string, or accepting a widget socket before `authenticate` and `startOrResume` succeed
- Forwarding client headers to the Conversation DO, or letting a client-sent `CONVERSATION_SESSION_HEADER` or `CONVERSATION_FEEDBACK_HEADER` through
- `/widget/bootstrap` reading the token from anywhere but `Authorization: Bearer`, skipping `authenticate`, writing any row, or answering with credentialed CORS
- A query validator (`zValidator`, a 400) that runs before the token is authenticated on a `/widget` route
- Routing the Conversation DO publicly (`routeAgentRequest`, `/agents/*`): it must be reachable only through `GET /widget/ws`
- Trusting a decoded claim (`iss`, `sub`, `roles`, a `company` claim) before the signature and claims checks pass, other than `iss` to find the connection row
- Fetching a JWKS (or any URL built from a token) for an issuer with no `company_connections` row, or with `redirect` other than `"manual"` (Workers throws on `"error"`; a 3xx must fail on `!ok`, never be followed)
- Adding `none`, `HS*` or any symmetric algorithm to the allowlist, or picking the verify algorithm from the JWK instead of the pinned header `alg`
- Importing a JWK with its private members, as extractable, or with usages beyond `["verify"]`
- A check that answers anything but 401 before the signature and claims pass (an issuer, connection-status or origin oracle)
- Reading a JWKS (or any fetched body) without a byte cap enforced while streaming
- Logging the token, echoing it in the selected subprotocol, or telling the widget which check failed

**Detection Pattern:**

```regex
alg.*(none|HS256|HS384|HS512)|searchParams\.get\(["']token|\?token=|routeAgentRequest
```

**Examples:**

```
- ❌ new WebSocket(`${url}?token=${jwt}`)
- ❌ return routeAgentRequest(request, env); // exposes /agents/conversation-do/<name>
- ❌ await stub.fetch(c.req.raw); // forwards client headers to the DO
- ✅ new WebSocket(url, ["diletta.v1", jwt]); // widget
- ✅ authenticate → startOrResume → getAgentByName(env.CONVERSATION_DO, publicId).fetch(new Request(url, { headers }))
```

**Fix:** Send the token in the subprotocol and route it through `WidgetAuthRepo.authenticate`; map `failure` with `WIDGET_AUTH_FAILURE_HTTP_STATUS_MAP`. See `routes/WidgetRoutes.ts`, `providers/widgetJwt.ts`, `providers/jwks.ts`, ADR 0001.

---

### 3.23 Conversation DO Stays Server-Authoritative [CRITICAL]

**Rule:** `ConversationDO` (Think) keeps Think locked down for a public widget: `workspaceBash = false`, `includeMcpTools = false`, `sendReasoning = false`, `sendIdentityOnConnect: false`, `activeTools` naming only `search_help_docs` (M2-6, and only when the turn's config lists knowledge sources) and the turn's loaded host tools (M3-4, rule 3.33), and `onChatError` returns only `MODEL_UNAVAILABLE_MESSAGE` or generic text. Every inbound frame passes `WidgetFrameProvider.admit` before Agents or Think see it: a chat request is rebuilt to carry only its newest user message (text, a new id, ≤ `WIDGET_MESSAGE_MAX_CHARS`), plus cancel and stream-resume frames, plus the widget's `host_token`, `change_request_decision`, `change_request_batch_decision` and `change_request_edits` frames (M3-4 / M3-5, handled by the DO itself, rules 3.33 and 3.34; decisions and edits limited per conversation, `DECISION_FRAMES_PER_WINDOW`), plus the widget's `feedback` frame (M2-7), which the DO stores itself through `FeedbackRepo` after syncing the read model (never handed to Think; a reply not synced in this conversation answers `rating: null`; `FeedbackRepo.recordFeedback` re-checks the conversation open and the company and chatbot active on every rating, a closing conversation refuses it, frames are limited per conversation (`FEEDBACK_FRAMES_PER_WINDOW`) and stored one at a time in arrival order; the ratings relayed on connect are capped at `CONVERSATION_FEEDBACK_MAX_RATINGS` and parsed entry by entry); everything else (clear, client-pushed messages, tool results and approvals, client state, rpc, regeneration) is refused. One turn runs at a time, none while closing; its ULID and the activity time are stored at admission, and `loadTurnConfig` re-checks the conversation, chatbot and company before the config and routed model are ready. The `messages` read model is synced from the transcript (`TranscriptProvider`) after every turn and on every wake, never written from anywhere else. Runtime state changes go through `patchRuntimeState` (no await between read and write); the auto-close never re-arms sooner than `CONVERSATION_CLOSE_RETRY_MS`.

**Violations:**

- Removing or widening the frame allowlist, or passing a client chat body through unchanged (client history, `clientTools`, custom fields, `trigger: "regenerate-message"`)
- Re-enabling workspace bash, fetch or MCP tools, or tools without an approved pin; any active tool but `search_help_docs` and the turn's loaded host tools, or activating search for a bot with no knowledge sources
- Returning a raw error or provider message from `onChatError`
- Calling a model outside `ModelRouterRepo.getModel` (pattern rule 3.10), or running a turn without a fresh `loadTurnConfig`
- Writing the read model anywhere but `ConversationsRepo.recordTurn`, or reading `messages` into a turn (the Think session is the source of truth)
- `this.configure({ ...state, … })` with a `state` read before an `await`
- Checking company, chatbot or conversation status only at connect time (they change while a socket is open)
- An auto-close or retry scheduled at a time that may already have passed
- Recording a turn's messages only once with no catch-up (a failed write or an eviction loses them)
- Reading `this.messages` in `webSocketMessage` before `__unsafe_ensureInitialized()` (after a hibernation wake it is empty), or syncing by array index
- Closing a conversation while its read model has an unsynced backlog, or doing database work inside `onStart` (it blocks every event)
- Keeping the host bearer token in Think state, `configure`, SQLite or a connection attachment (pattern rule 3.11)

**Detection Pattern:**

```regex
workspaceBash\s*=\s*true|includeMcpTools\s*=\s*true|fetchTools\s*=\s*\{
```

**Fix:** Mirror `durable-objects/ConversationDO.ts`.

---

### 3.24 Every Model Call Reserved Against the Budget [CRITICAL]

**Rule:** Every provider call a routed model makes (each retry too) is sized and held before it goes out, and a refused call never reaches the provider. `ModelCallRecordingProvider` estimates the prompt once per call, asks `budget.reserve` per attempt and sends that attempt with the hold's `maxOutputTokens`. `ModelCallBudgetProvider` is the only place a hold is sized, reserved and settled: input at the plain input rate, output cut to the caller's output tokens and cost left (refused under `MODEL_CALL_MIN_OUTPUT_TOKENS`), held by `GetModelRequest.caps` (the Conversation DO's `TurnBudget`) and then `BudgetDO.reserve`; each record settles its own hold. A call whose usage isn't known keeps its whole cost hold (never free) and counts no output tokens; an unsettled hold expires into spend. `maxTokensPerTurn` counts output tokens only. `BudgetDO` (one per company, reached only via `BudgetDO.forCompany`) is the only place company and chatbot-user spend is counted live: it Zod-parses every request, charges expired holds before reading the ledger for a check, keeps its arithmetic in `BudgetLedgerProvider` (pure, micro-dollars), reads Neon only through `BudgetRepo.getBudgetSeed` (NULL `spending_budget` = `DEFAULT_SPENDING_BUDGET_USD`), backs off a failed read for `BUDGET_LOAD_RETRY_MS`, and fails closed (`Unavailable`). The Conversation DO checks its own caps before routing and `BudgetDO.admitTurn` after it; a rate refusal answers `BUDGET_RATE_LIMIT_MESSAGE`, anything else `unavailable`, and the message isn't saved.

**Violations:**

- A model call that sends before `budget.reserve` resolves, a refused hold that still calls the provider (or retries), or an attempt sent with a `maxOutputTokens` other than its hold's
- Sizing, pricing or settling a hold outside `ModelCallBudgetProvider`, or a `ModelCallRecordingProvider.createMiddleware` without a real `budget` outside its unit test
- A `GetModelRequest` from the Conversation DO with `caps: null`
- Counting money in float dollars inside the budget path instead of micro-dollars (`usdToMicros`), or rounding a hold down
- Settling a Pending / Unknown call at 0, or releasing an expired reservation instead of charging it
- Reading BudgetDO's ledger for a check before its expired holds are charged, or an `await` between reading BudgetDO's state and writing it
- Storing an RPC request in BudgetDO without parsing it (`ZReserveBudgetRequest` etc.)
- A refusal treated as allowed when BudgetDO can't be reached or read (fail open)
- `env.BUDGET_DO.getByName(…)` anywhere but `BudgetDO.forCompany`
- Counting prompt tokens against `maxTokensPerTurn`, or using up a rate slot before the turn's model is routed
- Turn or conversation caps checked only once per turn instead of before every call, or `turnTimeoutSeconds` left out of `beforeTurn`
- Reading a company's budget or spend for BudgetDO outside `BudgetRepo` (tenant data, `withTenant`)

**Detection Pattern:**

```regex
createMiddleware\(\{(?![\s\S]{0,200}budget)
caps:\s*null
BUDGET_DO\.getByName
```

**Examples:**

```
- ❌ const reserved = await stub.reserve(req).catch(() => ({ isSuccess: true }));
- ❌ spentUsd += Number(costUsd);
- ❌ const ledger = this.getLedger(); const reservations = this.liveReservations(now); // stale ledger
- ✅ budget: { reserve: (estimate) => ModelCallBudgetProvider.reserve(this.env, { request: params, price, estimate }) }
```

**Fix:** Route through `ModelRouterRepo.getModel` with the turn's `TurnBudget`; mirror `providers/modelCallBudget.ts`, `durable-objects/BudgetDO.ts` and `providers/budgetLedger.ts` (`docs/runbooks/budget.md`).

---

### 3.25 Knowledge Ingestion Skips Unchanged Text [CRITICAL]

**Rule:** A knowledge source syncs only through `KnowledgeSourcesRepo.startSync` (route, upload, resume, Cron): the source row is locked `FOR UPDATE` and claimed (Syncing with a new `sync_run_id`) unless Paused or its heartbeat is fresh (`KNOWLEDGE_SYNC_STALE_MS`), then one `KnowledgeSyncWorkflow` instance starts under that id (`KnowledgeSyncWorkflowProvider`); a failed start puts the source in Failed. Only the run the source names may write: every write locks the source and requires Syncing + its `sync_run_id`, and refreshes `sync_heartbeat_at`; any other run answers Stopped. Workflow steps call `KnowledgeIngestionRepo`, return ids and outcomes only (never text or bytes), and throw when the Repo answers `isSuccess: false` so the step retries. Per item: fetch (`KnowledgeFetchProvider`: http(s) on the source's site, every redirect hop re-checked, capped in time and size) or read from R2 → convert (`KnowledgeExtractProvider`) → normalize (NUL dropped) → `content_hash` = `KNOWLEDGE_PIPELINE_VERSION` + sha256 of the text. An Indexed document whose hash matches is Unchanged: zero chunking and zero embed calls. A changed one is chunked (`KnowledgeChunkerProvider`, pure) and embedded (`KnowledgeEmbedProvider`, rows through `KnowledgeModelCallsProvider` in a transaction that rolls back on any failed row); its new bytes go to R2 as a new file before the transaction, which re-reads the document under the lock, writes the file row (`KnowledgeDocumentFilesProvider`) and deletes + rewrites the chunks. The new object is deleted if the item isn't stored; a replaced or removed file's object is deleted after the commit. Pruning runs only after a complete, non-empty listing. One document per (source, URL). Source URLs are public http(s) domains on the default port (`ZKnowledgeSourceUrl`); uploads are size-capped before parsing (`bodyLimit`) and type-checked by magic bytes. Tests may read `FILES_BUCKET` directly to check objects.

**Violations:**

- Embedding or re-chunking a document without first comparing its `content_hash`, hashing the bytes instead of the normalized text, or a chunker / embedding change without bumping `KNOWLEDGE_PIPELINE_VERSION`
- Creating a `KnowledgeSyncWorkflow` instance anywhere but `KnowledgeSyncWorkflowProvider.start`, or without claiming the source (and its `sync_run_id`) first
- Writing documents, chunks or the source's sync state without locking the source row and checking Syncing + `sync_run_id` in the same transaction (the Unchanged touch and Failed mark included)
- Holding the source lock while uploading bytes to R2, or overwriting an existing object in place
- Returning page text, markdown or bytes from a workflow step, or a step that returns `isSuccess: false` instead of throwing
- A fetch in ingestion without a timeout and a byte cap, `redirect: "follow"`, or following a URL off the source's site
- Pruning after a listing that is incomplete (`isComplete` false) or empty
- Updating `knowledge_chunks` in place instead of delete + insert, or chunks whose `knowledge_source_id` differs from their document's
- Ignoring a `createModelCall` result for an embed row
- Parsing an upload body before `bodyLimit`

**Detection Pattern:**

```regex
KNOWLEDGE_SYNC_WORKFLOW\.create\((?!.*knowledgeSyncWorkflow\.ts)
FILES_BUCKET\.(put|delete|get|list)\((?!.*fileStorage\.ts)
update\(knowledgeChunks\)
redirect:\s*"follow"
```

**Examples:**

```
- ❌ await env.KNOWLEDGE_SYNC_WORKFLOW.create({ params }); // in a route, no claim
- ❌ const embedded = await KnowledgeEmbedProvider.embed(env, { texts }); // before checking existing.contentHash
- ❌ return await step.do("item-0", () => ({ text })); // page text in workflow state
- ❌ const owned = source.status === Syncing; // no sync_run_id check: a run left behind keeps writing
- ✅ if (existing && existing.contentHash === contentHash && existing.indexStatus === Indexed) { /* touch lastSyncedAt only */ }
```

**Fix:** Mirror `repositories/KnowledgeIngestionRepo.ts`, `repositories/KnowledgeSourcesRepo.ts` and `workflows/KnowledgeSyncWorkflow.ts` (`docs/runbooks/knowledge.md`).

---

### 3.26 Knowledge Search Stays Inside the Bot's Sources and Fenced [CRITICAL]

**Rule:** Knowledge is searched only through `KnowledgeSearchRepo.search`, called only by the Conversation DO's `search_help_docs` tool on the running turn's config. The source filter is the bot's `knowledge.sourceIds` resolved to internal ids in the company (`KnowledgeSourcesDAL.getKnowledgeSourceIds`); no source left (or a blank query) means no hits and no model call. Both sides of the hybrid search (`KnowledgeChunksDAL.searchKnowledgeChunksByVector` / `…ByKeyword`) run in one `withTenant` and filter on company, source ids, `embedding_model = KNOWLEDGE_EMBEDDING_MODEL` and Indexed documents; the vector side sets `hnsw.iterative_scan` and `hnsw.ef_search` with `set_config(…, true)` (never per session) and orders by the distance alone. Fusion and the score cut live in `KnowledgeRankingProvider` (pure), reranking in `KnowledgeRerankProvider`; rerank scores are never stored. Every Workers AI call made (failed too) gets its `model_calls` row with the search's chatbot, user, conversation and turn, written in `waitUntil` and never counted in the company budget. The tool's output (stored in the transcript, streamed to the widget) carries citations only (`SearchHelpDocsProvider.toOutput`); excerpt text stays in the running turn's memory (`ActiveTurn.searchExcerpts`) and reaches only the model, through `SearchHelpDocsProvider.toModelText` (inside `<search_results>`, marked as data, fence tags defused). The read model gets only `content.citations` for the `[n]` markers the reply uses (`Schemas.citedBy`). Rerank scores are probabilities as Workers AI returns them; a score outside [0, 1] is refused, never re-mapped. The query text is never logged.

**Violations:**

- Searching `knowledge_chunks` outside `KnowledgeChunksDAL`'s search methods, or without the source, embedding-model and Indexed filters
- Taking the source list from anywhere but the turn's loaded config (a client value, another bot's config), or resolving source ids outside the company
- `SET hnsw.*` / `set_config('hnsw.…', …, false)` (session-wide on a pooled connection), or an ORDER BY on the vector side that the HNSW index can't serve
- Passing chunk text to the model outside the fence, or returning the tool's raw JSON as its model output
- Chunk text in the tool's output (it is stored and streamed to the widget), or excerpts kept anywhere but the running turn's memory
- A search call with no `model_calls` row, or a search call counted against the company budget
- Storing rerank scores, or citations for results the reply didn't cite
- Logging the search query or chunk text

**Detection Pattern:**

```regex
\.from\(knowledgeChunks\)(?!.*KnowledgeChunksDAL\.ts)
set_config\('hnsw\.[a-z_]+',\s*[^,]+,\s*false\)
SET\s+(?!LOCAL)hnsw\.
```

**Examples:**

```
- ❌ const hits = await tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.companyId, companyId)); // no source filter
- ❌ execute: async ({ query }) => JSON.stringify(hits) // chunk text unfenced
- ❌ AppLogger.info({ message: "Searched", metadata: { query } })
- ❌ return { status, results: hits }; // excerpt text in the output reaches the widget
- ✅ toModelOutput: ({ toolCallId, output }) => ({ type: "text", value: SearchHelpDocsProvider.toModelText(output, this.turnSearchExcerpts(toolCallId)) })
```

**Fix:** Mirror `repositories/KnowledgeSearchRepo.ts`, `durable-objects/ConversationDO.ts` (`getTools`, `searchHelpDocs`) and `providers/searchHelpDocs.ts` (`docs/runbooks/knowledge.md`).

### 3.27 Widget Renders Data, Never Trusts It [CRITICAL]

**Rule:** The widget (`apps/widget`, M2-7) runs on a host's page and reads from a socket and an API it doesn't control. Everything it receives is parsed before use: DO frames with `ZWidgetServerMessage`, the bootstrap with `ZWidgetBootstrapApiResponse`, tool outputs with their schema (`ZSearchHelpDocsOutput`), embed options with `ZWidgetEmbedConfig`. Reply text goes through the widget's own markdown parser (`lib/markdown.ts`) into React elements: no raw HTML, no images, links only `http(s):`/`mailto:` with `rel="noopener noreferrer nofollow"`. It lives in its shadow root: styles only through `prepareShadowCss`, nothing written to the host document but the `@property` rules and the fonts link (namespaced ids), no global listeners or `window` keys beyond `window.Diletta`. The companion JWT comes from `getToken` for every connect and every bootstrap read and is never stored (memory, `localStorage` or logs); `localStorage` holds only the saved conversation publicId, keyed by the SHA-256 of the token's `sub` (`lib/hostUser.ts`, the one `crypto.subtle` use in the widget: a hash of a browser-side key, not company data), learned from every token. The socket opens only for a first message or a saved conversation, and a new conversation id is saved before anything is sent; a saved conversation the server keeps refusing is dropped and the widget goes idle (no new conversation until the visitor sends a message), and a failed `getToken` is counted as a failed connect but never drops it. Types and props live in `packages/schemas` (`WidgetUi.ts`); sizes come from the preset or the widget's own `@theme` tokens in `widget.css`, never arbitrary values. One store per widget (`createWidgetStore`), never module state. The script-tag bundle stays within `WIDGET_BUNDLE_MAX_GZIP_BYTES` (`scripts/checkBundleSize.ts` fails the build).

**Violations:**

- Acting on a frame, bootstrap body or tool output without its Zod schema, or casting it
- `dangerouslySetInnerHTML`, a markdown library or `innerHTML` for reply text, or a link with any other scheme
- Writing styles or nodes into the host document beyond `#diletta-widget-properties` / `#diletta-widget-fonts`, or using `:root`/rem-sized CSS without `prepareShadowCss`
- Keeping the token in state, storage or a module variable, or putting it in a URL
- Opening the socket on page load or panel open without a saved conversation (it creates a conversation row), or after a saved conversation was dropped without a message waiting
- The raw `sub` (or any token claim) in a `localStorage` key or value
- A module-level store or singleton shared by widget instances
- Raising the bundle budget, or skipping the size check, without updating the dev plan's open question

**Detection Pattern:**

```regex
dangerouslySetInnerHTML|innerHTML\s*=|localStorage\.setItem\([^)]*token|react-markdown
```

**Examples:**

```
- ❌ const frame = JSON.parse(event.data) as WidgetServerMessage;
- ❌ <div dangerouslySetInnerHTML={{ __html: reply }} />
- ✅ const parsed = Schemas.ZWidgetServerMessage.safeParse(json); if (!parsed.success) return;
- ✅ <Markdown text={message.text} isStreaming={message.isStreaming} />
```

**Fix:** Parse with the schema in `packages/schemas/src/widget/` or `widgetAuth/`, render through `components/Markdown.tsx`, and see `docs/runbooks/widget.md`.

### 3.28 A Thumbs-Down Opens Its User Issue in the Rating's Transaction [CRITICAL]

**Rule:** A user quality issue (source User, M2-8) opens only from `FeedbackRepo.recordFeedback`, in the same `withTenant` that saves the Down rating, through `UserQualityIssueProvider.open(tx, …)`: `QualityIssuesDAL.createUserQualityIssue` (one issue per feedback row, `UNQ_quality_issues_feedback_id`, insert `ON CONFLICT DO NOTHING`; the DAL checks the feedback rates a message of that conversation; `isCreated` always set on success), then, only when opened now, `CriticalEventProvider.record` (`quality_issue.opened`, actor ChatbotUser, `parentLogId` and `rootLogId` = the conversation's root log). A failure comes back as `isSuccess: false` and the Repo throws `TenantRollbackError`, so the rating, the issue and the event commit together or not at all. The issue opens Open with `issue_type`, `note` and `created_by` null (admins triage it); switching to Up leaves it as it is, and a second Down opens nothing and records no event. Quality issue event names and dedupe keys come only from `Schemas.QUALITY_ISSUE_ENTITY_TYPE`, `QualityIssueEntityActionEnum`, `qualityIssueEventType` and `qualityIssueEventDedupeKey` (shared with `ModelKeyFailureProvider`), never spelled inline. The DO relays the returned `outboxId` in `waitUntil` after the commit; it never reaches the widget.

**Violations:**

- Inserting a source-User issue anywhere but `QualityIssuesDAL.createUserQualityIssue`, or calling it outside the rating's transaction
- Saving the rating when the issue or its event failed (returning instead of throwing `TenantRollbackError`)
- Closing, dismissing or deleting the issue when the visitor switches to Up, or opening a second issue / event on a repeat Down
- Copying reply or user text into the issue's `note`, or setting `issue_type` before triage
- `outboxId` or any internal id in a widget frame
- A quality issue event type, entity name or dedupe key written as a string literal

**Detection Pattern:**

```regex
\.insert\(qualityIssues\)
UserQualityIssueProvider\.open\(
["'`]quality_issue(\.|["'`])
```

A hit is a violation outside its home: `.insert(qualityIssues)` only in `data-access-layer/QualityIssuesDAL.ts` (and owner-connection test fixtures), `UserQualityIssueProvider.open(` only in `repositories/FeedbackRepo.ts`, and the `quality_issue` literal only in `packages/schemas/src/qualityIssues/QualityIssuesCommon.ts` (tests may assert on it).

**Examples:**

```
- ❌ if (!opened.isSuccess) return refuse(Schemas.RecordFeedbackFailureEnum.ServerError, opened.message); // rating already upserted, commits alone
- ❌ await withTenant(db, companyId, (tx) => UserQualityIssueProvider.open(tx, …)); // a second transaction
- ❌ dedupeKey: `quality_issue.opened:${qualityIssue.publicId}` // spelled inline
- ✅ if (!opened.isSuccess) throw new TenantRollbackError(opened.message ?? "User quality issue not opened");
- ✅ dedupeKey: Schemas.qualityIssueEventDedupeKey(Schemas.QualityIssueEntityActionEnum.Opened, qualityIssue.publicId)
```

**Fix:** Mirror `providers/userQualityIssue.ts`, `repositories/FeedbackRepo.ts` (`recordFeedback`) and `durable-objects/ConversationDO.ts` (`recordFeedback`).

---

### 3.29 Tool Ops Are Versioned Data, Rendered Only by renderToolOp [CRITICAL]

**Rule:** A tool definition's ops (`input_schema`, `call_op`, `readback_op`, `inverse_op`, one unit at `tool_definitions.schema_version`, M3-1) are written only through `Schemas.normalizeToolOps` (current version, shapes and placeholder references checked) and read only through `Schemas.loadToolOps` (upgraded from the row's version); `ToolDefinitionsRepo` checks the risk with `Schemas.getToolRiskOpsIssue` on every write and before activating. Placeholders (`{args.*}`, `{before.*}`, `{result.*}`) are filled only by `Schemas.renderToolOp`, which encodes path values, refuses an empty path value, an empty segment and a `.` / `..` segment, and never throws; nothing builds a host URL or body from an op by hand. Only a Draft version is edited or deleted (the DAL matches Draft rows only); an Active or Disabled version never changes again, and a change is a new version (`createToolDefinitionVersion`, one Draft per name under the name's advisory lock). Tool definitions are operator-curated: the routes live under `/operator/companies/:companyPublicId/tool-definitions` with `authorizePlatform(ToolDefinition*)` then `resolveOperatorCompany()`, and every query runs in `withTenant` on the resolved company.

**Violations:**

- Writing an op column without `normalizeToolOps`, or storing ops at anything but its returned `schemaVersion`
- Parsing stored ops with `ZToolOps*.parse` / `safeParse` outside `packages/schemas` instead of `loadToolOps`
- Writing a `loadToolOps` result back to the row (a stored version is immutable)
- String-building a request from an op (`op.path.replace(…)`, template literals with `args`) instead of `renderToolOp`
- Updating or deleting a tool definition row that isn't a Draft, or editing `name`
- A tool definition route without `authorizePlatform` + `resolveOperatorCompany`, or under `/dashboard/*`
- Editing a released `ZToolOpsV<n>` instead of adding `ZToolOpsV<n+1>` with an upgrader (rule 3.12)
- A tool whose connection isn't Active, REST and with a `base_url` saved or activated
- A failure → HTTP status mapping outside `TOOL_DEFINITION_FAILURE_HTTP_STATUS_MAP`
- Calling `renderToolOp` with args not first checked against the tool's `input_schema` (the renderer drops a missing arg's key; it doesn't know which args are required)
- Picking a tool by name or "latest Active" instead of a config's `{ name, version }` pin, or disabling other versions when one is activated

**Detection Pattern:**

```regex
\.(insert|update)\(toolDefinitions\)
ZToolOps(V\d+)?\.(safe)?[pP]arse\(
\.(callOp|readbackOp|inverseOp)\.path\.replace\(
```

A hit is a violation outside its home: `.insert(toolDefinitions)` / `.update(toolDefinitions)` only in `data-access-layer/ToolDefinitionsDAL.ts` (and owner-connection test fixtures), `ZToolOps*.parse` only in `packages/schemas/src/toolDefinitions/` (tests may build fixtures with it).

**Examples:**

```
- ❌ await this.dal.createToolDefinition(tx, { ...body, callOp: body.ops.callOp, schemaVersion: 1 }); // not normalised
- ❌ const url = `${baseUrl}/records/${args.recordId}`; // hand-built, unencoded
- ❌ .where(eq(toolDefinitions.publicId, publicId)) on an update of an active version
- ✅ const normalized = Schemas.normalizeToolOps(body.ops); // then store normalized.ops at normalized.schemaVersion
- ✅ const rendered = Schemas.renderToolOp(ops.callOp, { args }); if (!rendered.isSuccess) …
```

**Fix:** Mirror `repositories/ToolDefinitionsRepo.ts`, `data-access-layer/ToolDefinitionsDAL.ts` and `packages/schemas/src/toolDefinitions/ToolOpRenderer.ts`.

---

### 3.30 Host Calls Only Through @app/adapter [CRITICAL]

**Rule:** Every call to a company's host API goes through `@app/adapter` (`RestAdapter`, M3-2) with a request from `Schemas.renderToolOp`. The host bearer token reaches a request only through an AuthStrategy in `AUTH_STRATEGIES`, which matches `Schemas.SUPPORTED_AUTH_TYPES`. A write passes its tool's `idempotency_mode` and a key, an Emulated write its `appliedCheck` (both sides: `getCommitCheckExpectations` / `getUndoCheckExpectations`), and a write that may have landed (`mayHaveLanded` on any non-success outcome, `TokenNeeded` / `TokenRejected` included, or a step interrupted mid-call) is called again only with `isResume: true`, never as a fresh write. An Emulated write tool's readback_op and inverse_op never read `{result.*}`.

**Violations:**

- `fetch(` to a host URL (a connection's `base_url`, or anything built from a tool op) outside `packages/adapter/src/`
- Following redirects, or building a host URL by string concatenation instead of `buildHostUrl`
- An `Authorization` header built outside an AuthStrategy, or a token in a `HostCallResponse` message, a log or an error
- A new auth type in `SUPPORTED_AUTH_TYPES` without its strategy in `AUTH_STRATEGIES` (or the reverse); a connection saved, or a tool definition saved or activated on a connection, whose auth settings fail `getAuthConfigIssue`
- An Emulated resend decided on a readback mismatch alone: only a readback that still shows the replaced values (`notLanded`) allows a resend
- Retrying a write in the caller (a loop around `execute` / `undo`) instead of the adapter's mode rules, or resending a write that may have landed with `isResume: false`
- An `idempotency_mode` None write resent after an `Unknown` outcome
- A risk / idempotency check on a tool definition without `getToolRiskOpsIssue(risk, idempotencyMode, ops)`

**Detection Pattern:**

```regex
\bfetch\(
Authorization["']?\s*:
Idempotency-Key
```

A hit is a violation outside its home: host calls and auth headers only in `packages/adapter/src/` (other `fetch` uses — JWKS, knowledge fetch, AI Gateway — have their own files and rules).

**Examples:**

```
- ❌ await fetch(`${connection.baseUrl}${rendered.request.path}`, { headers: { Authorization: `Bearer ${this.hostToken}` } })
- ❌ for (let i = 0; i < 3; i++) { const r = await adapter.execute(call); if (r.isSuccess) break; }
- ✅ const created = RestAdapter.create({ connection, getHostToken: () => this.hostToken });
- ❌ await adapter.execute({ ...call, isResume: false }); // after a TokenNeeded refresh: drops mayHaveLanded
- ✅ await adapter.execute({ risk, request, idempotencyMode, idempotencyKey, appliedCheck, isResume: response.mayHaveLanded === true })
```

**Fix:** Mirror `packages/adapter/src/RestAdapter.ts`; add an auth type as a strategy in `AuthStrategies.ts` plus its config schema in `SUPPORTED_AUTH_TYPES`.

---

### 3.31 The Test Host Stays a Test Fixture [HIGH]

**Rule:** `apps/test-host` (M3-3) is a stand-in customer app for our own test company, staging only. Platform code (`apps/backend/src` outside `tests/`, `apps/web`, `apps/widget`, `packages/*`) never imports it or names its URL. Its types live in `packages/schemas/src/testHost/`. Backend tests reach it only through `src/tests/helpers/testHost.ts`: the `TEST_HOST` service binding of the auxiliary worker (fresh secrets per run, `testBindings.ts`), admin calls (token minting, faults, reset) through the helper, and every record call through `@app/adapter` with ops rendered from `Schemas.TEST_HOST_TOOL_DEFINITIONS`. Its connection is a Staging one; there is no production test host. Its tools change only in `TEST_HOST_TOOL_DEFINITIONS`, stored by `pnpm --filter test-host seed` as a new version. It signs tokens with its own key, not company data, so its WebCrypto use is outside rule 3.19.

**Violations:**

- An import from `apps/test-host` (or `test-host`) in platform code, or `TEST_HOST_STAGING_ISSUER` used outside the test host, its seed and tests
- A backend test calling `/v1/*` on the test host with its own `fetch` instead of the adapter, or reading `TEST_HOST_SIGNING_KEY`
- A test host route without its middleware: `/auth/tokens` and `/control/*` without `requireAdmin`, `/v1/*` without `requireHostToken`
- A production env, a production connection, a production deploy workflow, or a `deploy` script without `--env staging` for the test host
- A secret piped from `pnpm keygen` without `--silent` (pnpm's banner lands in the secret)
- A tool definition for the test host company edited by hand instead of through `TEST_HOST_TOOL_DEFINITIONS` + seed
- `console.log` or a token, admin secret or request body in a test host response or error

**Detection Pattern:**

```regex
from ["'][^"']*test-host
TEST_HOST_(STAGING_ISSUER|SIGNING_KEY|ADMIN_SECRET)
diletta-test-host
```

**Examples:**

```
- ❌ await fetch(`${issuer}/v1/records/rec_alpha`, { headers: { Authorization: `Bearer ${hostToken}` } }) // in a backend test
- ✅ await testHostAdapter(() => hostToken).execute({ risk, request: render(testHostTool("get_record").ops.callOp, { args }) })
- ❌ await setTestHostFaults(workspace, [{ kind: "status", status: 503, isApplied: true }]) // unfiltered: the read-before takes it
- ✅ await setTestHostFaults(workspace, [{ kind: "status", status: 503, isApplied: true, method: "PATCH" }])
```

**Fix:** Mirror `apps/backend/src/tests/testHost.test.ts` and `apps/test-host/src/routes/RecordsRoutes.ts`; runbook `docs/runbooks/test-host.md`.

---

### 3.32 One Cron Trigger per Worker [HIGH]

**Rule:** The backend declares exactly one cron trigger (`Constants.CRON_TRIGGER`, every minute; `wrangler.jsonc` `triggers.crons` holds only that), because the account's Workers Free plan allows 5 cron triggers in total across every Worker and env (a deploy over the limit fails with code 10072 and leaves its triggers half-updated). Which jobs run is decided by time in `CronScheduleProvider.getDueJobs(controller.scheduledTime)` (pure, UTC, unit-tested), and `scheduled()` runs them through `CRON_JOBS` (a `Record<Schemas.CronJobEnum, …>`) with `Promise.allSettled`. Every job tolerates a skipped tick.

**Violations:**

- A second entry in `triggers.crons`, or a `triggers` block in an env, a `switch (controller.cron)` on several expressions, or a new Worker with crons without checking the account's total
- A job scheduled outside `CronScheduleProvider`, or reading the wall clock (`Date.now()`) instead of `controller.scheduledTime` to decide what is due
- A new `CronJobEnum` value without its `CRON_JOBS` entry and a `cronSchedule.test.ts` case
- Jobs awaited one after another, so one failure skips the rest

**Detection Pattern:**

```regex
"crons"\s*:\s*\[[^\]]*,
controller\.cron
```

**Examples:**

```
- ❌ "triggers": { "crons": ["* * * * *", "0 * * * *"] }
- ✅ "triggers": { "crons": ["* * * * *"] }  // hourly work: CronScheduleProvider, at CRON_HOURLY_MINUTE
- ❌ case "0 3 * * *": await runActivityLogPartitions(env);
- ✅ if (time.getUTCMinutes() === Constants.CRON_HOURLY_MINUTE) jobs.push(Schemas.CronJobEnum.KnowledgeResync);
```

**Fix:** Mirror `apps/backend/src/providers/cronSchedule.ts` and `scheduled()` in `apps/backend/src/index.ts`.

---

### 3.33 Host Tool Calls Go Through the Action Engine [CRITICAL]

**Rule:** A host tool runs only as one of the turn's tools loaded by `ActionEngineRepo.loadTurnTools` (the config's exact `{name, version}` pins, Active, on a connection that can serve calls; write tools left out for a read-only company). Every call's args pass `Schemas.validateToolArgs` (undeclared keys cut at every depth; an input_schema using a keyword zod would accept but not enforce is refused) before `renderToolOp`, and a repeat of the same tool + args in a turn is refused and stops the turn. Reads go through `HostToolCallProvider.read` and reach the model only through `HostToolsProvider.toModelText` (`<host_data>` fence); a read or a help docs search makes the turn untrusted, and an earlier turn's untrusted content is found by what its tool parts hold (`HostToolsProvider.hasUntrustedHistory`), never by tool name. A write is a Think `durable-pause` action: its approval hook reads before (`HostToolCallProvider.readBefore`, none for a create), builds the diff with `Schemas.buildChangeRequestChanges` from the read-before and the validated args (every arg `call_op` sends is on it: compare fields, other sent args as set, path args as unchanged), and stores the tool call, the change request (values only in `encrypted_changes` / `encrypted_args`, through `CompanyKeyProvider`) and its event in one `withTenant` (`ActionEngineRepo.proposeChange`). Whether the user must approve is `HostToolsProvider.decideApproval` alone (a matching `blocked` rule refuses any tool; destructive tools and untrusted turns always need approval), on the roles of the newest JWT only until its exp. A pause is resolved only by the DO's decision path (`change_request_decision` / `change_request_batch_decision` frames, or the expiry) through Think's `approveExecution` / `rejectExecution`, after the change request is decided in the database (which enforces the approval deadline); the decision claims the conversation (`isDeciding`) before its first await, follows the row's status whoever set it, and an approval needs the host token in memory. Every change request status change goes through `ActionEngineRepo` (locked row, allowed from-statuses) with its `change_request.<action>` critical event in the same transaction; a refused step always names its `failure` (a rollback is `ServerError`). A commit marks Committing (with `changeRequestCommitIdempotencyKey`) before the host call, and a Committing one is only ever resumed with `isResume: true`, with the host token in memory (never ended NeedsHuman for a resume that couldn't send).

**Violations:**

- Offering a tool loaded by name, a Draft / Disabled version, or a write tool to a read-only company
- Rendering or sending a call whose args weren't checked by `validateToolArgs`, or storing args the input_schema doesn't declare
- Building an approval diff from the model's text, or showing values that didn't come from the read-before and the args
- Host data, a diff value or args in a log, the transcript's write outputs, the read model, an event's `detail` or a plain column
- Calling `approveExecution` / `rejectExecution` from anywhere but the DO's decision and expiry path, or before the change request is decided; admitting Think's own tool approval frames from the widget
- A change request status written without its critical event, or outside `ActionEngineRepo`
- An approval rule or tool setting that lets a destructive tool, or a write in an untrusted turn, skip approval
- A commit sent before Committing (and its key) is stored, or a Committing one resent with `isResume: false`
- Treating a `withTenant` refusal without `failure` as settled (dropping the entry), or deciding on `this.activeTurn` checked before an await without claiming the conversation
- An approval accepted after `created_at + CHANGE_REQUEST_APPROVAL_EXPIRY_MS`
- Telling the model a change failed while its entry is kept for a retry

**Detection Pattern:**

```regex
approveExecution\(|rejectExecution\(
renderToolOp\(
kind:\s*"durable-pause"
```

A hit outside `ConversationDO.ts`, `providers/hostToolCall.ts` and `packages/schemas` needs a reason.

**Examples:**

```
- ❌ actions[name] = action({ execute: () => adapter.execute({ risk, request: renderToolOp(op, { args: input }).request! }) })
- ✅ approval: async ({ input, ctx }) => await this.proposeWrite(toolName, input, ctx.toolCallId)
- ❌ await this.approveExecution(executionId); await repo.decideChangeRequest(...)
- ✅ const decided = await repo.decideChangeRequest(...); if (decided.isSuccess) await this.approveExecution(executionId);
- ❌ changes: [{ field: "amount", before: modelSaidBefore, after: args.amount }]
- ✅ Schemas.buildChangeRequestChanges({ kind, callOp, readbackOp, args, before: readBefore.body })
```

**Fix:** Mirror `apps/backend/src/durable-objects/ConversationDO.ts` (`proposeWrite`, `runCommit`, `decideChangeRequests`, `resolvePauses`) and `repositories/ActionEngineRepo.ts`.

---

### 3.34 An Edited Change Is Re-Checked Like a New Proposal [CRITICAL]

**Rule:** The widget's edits to a proposal (`change_request_edits`, M3-5) change nothing until the Conversation DO re-checks them, never trusting what the widget allowed: `ActionEngineRepo.getEditPlan` (Proposed, before `created_at + CHANGE_REQUEST_APPROVAL_EXPIRY_MS`, the conversation, chatbot and company re-checked and not read-only, the tool version still loading) → `Schemas.applyChangeRequestEdits` (only `Schemas.getEditableFields`: args `call_op` sends in its query or body; never the path args that pick the record, nothing for a delete) → `Schemas.validateToolArgs` on the whole edited args → the read-before again as the user (`HostToolCallProvider.readBefore`, none for a create) → `Schemas.buildChangeRequestChanges` from that read and the edited args → refused when nothing changes → `ActionEngineRepo.saveEdit` (re-checks the status and deadline under the row lock; new `encrypted_changes`, `summary`, `change_count`, `was_edited`, and a `change_request.edited` event by the chatbot user, one transaction). The change request stays Proposed with its original deadline: only an answer after the user saw the re-checked diff approves it, and the commit sends the payload's args, never values from the widget. Answers to several proposals go in one `change_request_batch_decision` frame: every one is decided in the database, the approved ones committed, and only then are the pauses resolved, back to back, so the model replies once (`execute` answers the commit's cached outcome).

**Violations:**

- Committing, approving or storing widget-sent values without the steps above, or approving in the edit step
- Letting an edit name a path arg (the record id), a field `getEditableFields` doesn't list, or skip `validateToolArgs` because the widget checked it
- Rebuilding the diff from the old read-before, or from the widget's text, instead of a fresh read
- Extending the approval deadline on an edit, or saving an edit after it
- Resolving one pause per batch answer while others of the batch are still being decided or committed (several model replies, refused answers)

**Detection Pattern:**

```regex
updateChangeRequestPayload\(
applyChangeRequestEdits\(
WIDGET_CHANGE_REQUEST_(EDITS|BATCH_DECISION)_FRAME_TYPE
```

A hit outside `ConversationDO.ts`, `ActionEngineRepo.ts`, `ChangeRequestsDAL.ts`, `providers/widgetFrames.ts`, `apps/widget/src/hooks/useChangeReview.ts` and `packages/schemas` needs a reason.

**Examples:**

```
- ❌ payload.args = { ...payload.args, ...edit.values }; await repo.saveEdit({ payload })
- ✅ applyChangeRequestEdits → validateToolArgs → readBefore → buildChangeRequestChanges → repo.saveEdit
- ❌ for (const d of decisions) { await this.decideInDatabase(...); await this.approveExecution(id); }
- ✅ decide all → runCommit each approved → resolvePauses(decided)
```

**Fix:** Mirror `ConversationDO.applyEdit` / `decideChangeRequests` and `ActionEngineRepo.getEditPlan` / `saveEdit`.

---

### 3.35 A Commit Counts Only Once Its Read-After Verifies It [CRITICAL]

**Rule:** A write the host answered 2xx is Committed, not done (M3-6). In the same Conversation DO step (`runFollowUp`), before the action's `execute` answers, it is read back as the user (`HostToolCallProvider.readAfter`: `readback_op` with the args and the commit's own result, kept in the encrypted payload v2) and judged only by `Schemas.checkReadAfter` → `ChangeRequestsProvider.verifyEnd` in `ActionEngineRepo.finishVerify`: every compare field the args set reads back as sent (a delete: the record gone, 404) → Verified; anything else that answered → Mismatch, with what it found (`mismatches`, encrypted, the widget's frame only); a read that failed, answered otherwise or has nothing to compare → NeedsHuman `verify_unknown`, **never an undo on a guess**. A Mismatch is auto-undone at once, per change request: no `inverse_op` → NeedsHuman `not_undoable`; else the undo key (`changeRequestUndoIdempotencyKey`) is stored with its `undoing` event before `HostToolCallProvider.undo` sends `inverse_op` (Emulated: checked first with `getUndoCheckExpectations`), then the record is read again and `undoEnd` decides: back to its read-before values (a create: gone) → Undone, otherwise NeedsHuman `undo_failed` / `undo_unconfirmed`. A step that couldn't be sent for want of the host token keeps the entry (`verifying` / `undoing`) for the next `host_token`; an eviction resumes from the row (`startFollowUp`: Committed → read-after, Mismatch → undo, `isResume` when the undo key is stored). Every status change is one `change_request.<action>` event. The model hears Verified / Undone / needs review, never "made" for an unchecked write.

**Violations:**

- Treating Committed as the end: answering the model or the widget "done" before the read-after, or skipping it for a tool or mode
- Deciding verified / mismatch outside `Schemas.checkReadAfter` (e.g. comparing the commit's own response, or the model's words)
- Undoing on an unknown read-after, or on anything but a Mismatch row; undoing without storing the undo key first
- Sending the undo with the commit's key, or resuming a Mismatch whose undo key is stored without `isResume`
- Putting `result` or `mismatches` in a log, an event's detail, the transcript or the read model (they are host data)

**Detection Pattern:**

```regex
HostToolCallProvider\.(readAfter|undo)\(
finish(Verify|Undo)\(|startFollowUp\(
ChangeRequestStatusIntEnum\.(Verified|Mismatch|Undone)
```

A hit outside `ConversationDO.ts`, `ActionEngineRepo.ts`, `providers/changeRequests.ts`, `providers/hostToolCall.ts`, `apps/widget/src/lib/changeRequestView.ts` and `packages/schemas` needs a reason.

**Examples:**

```
- ❌ if (committed.outcome === Succeeded) return output(Committed, "The change was made.")
- ✅ finishCommit → runFollowUp: readAfter → finishVerify → (Mismatch) undo → readAfter → finishUndo
- ❌ if (read.outcome !== Succeeded) await HostToolCallProvider.undo(...)
- ✅ checkReadAfter(...).verdict === Unknown → NeedsHuman verify_unknown
```

**Fix:** Mirror `ConversationDO.runFollowUp` and `ActionEngineRepo.finishCommit` / `finishVerify` / `finishUndo` / `startFollowUp`.

---

### 3.36 Undo Only Inside Its Window, Re-Checked; Values Purged Only by the Purge Job [CRITICAL]

**Rule:** A Verified change request is undone by the user (M3-7) only through the widget's `change_request_undos` frame, and only after `ActionEngineRepo.startUndo` re-checks it like a commit: the conversation open, the chatbot and company active and not read-only, then under the row lock `ChangeRequestsProvider.undoRefusal` (Verified with no undo under way, the tool has an `inverse_op`, the values not purged, before `undo_until`) and the tool version still loading. The user's own undo key (`changeRequestUserUndoIdempotencyKey`) and its `undoing` event (actor: the chatbot user) are stored before `HostToolCallProvider.undo`; the change request stays Verified until `finishUndo` ends it (Undone / stays Verified with an `undo_not_sent` event when nothing may have reached the host / NeedsHuman), or until the DO hands an undo never resumed to a person (`abandonUndo`, `undo_interrupted`) after `undo_until` + `CHANGE_REQUEST_UNDO_GRACE_MS`. `undo_until` is written only through `ChangeRequestsProvider.undoUntil` (end + `CHANGE_REQUEST_UNDO_WINDOW_MS`; NeedsHuman null). `encrypted_changes`, `iv` and `encryption_key_version` are nulled only by `ChangeRequestsDAL.purgeChangeRequestValues` via `ChangeRequestPurgeRepo` (the `ChangeRequestPurge` cron, `withPlatform`), never before `undo_until`, and for a Verified row holding the user's undo key not before `undo_until` + the grace (the SQL builds that key from `CHANGE_REQUEST_KEY_PREFIX` / `CHANGE_REQUEST_USER_UNDO_KEY_SUFFIX`, never a literal). An undo makes no model call: every later turn hears it through `userUndos` (summaries, never values).

**Violations:**

- Sending `inverse_op` for a Verified change request without `startUndo`, or trusting the widget's view of the window
- Undoing after `undo_until`, on a read-only company, or a NeedsHuman / Undone / Mismatch row through the user path
- Setting `undo_until` by hand in a step, or giving NeedsHuman one
- Nulling the payload anywhere but the purge, or purging a row whose window hasn't ended or whose user undo is under way
- Running a model call (or a continuation) to announce an undo, or putting values in `userUndos`
- Writing a status event for an undo that changed no status (use `undo_not_sent`), or guessing who undid a change from its payload instead of `undoneBy`

**Detection Pattern:**

```regex
startUndo\(|undoRefusal\(|purgeChangeRequestValues\(
undoUntil:
encryptedChanges: null
WIDGET_CHANGE_REQUEST_UNDOS_FRAME_TYPE
```

A hit outside `ConversationDO.ts`, `ActionEngineRepo.ts`, `ChangeRequestPurgeRepo.ts`, `ChangeRequestsDAL.ts`, `providers/changeRequests.ts`, `providers/widgetFrames.ts`, `apps/widget/src/hooks/useChangeReview.ts`, `apps/widget/src/lib/changeRequestView.ts` and `packages/schemas` needs a reason.

**Examples:**

```
- ❌ if (view.undoUntil > Date.now()) await HostToolCallProvider.undo({ plan, getHostToken })
- ✅ repo.startUndo → runFollowUp(plan) → finishUndo
- ❌ await tx.update(changeRequests).set({ encryptedChanges: null }).where(eq(changeRequests.status, Verified))
- ✅ ChangeRequestPurgeRepo.purgeExpiredValues() (undo_until < now, undo under way skipped)
```

**Fix:** Mirror `ConversationDO.undoChangeRequests` / `runUserUndo`, `ActionEngineRepo.startUndo` and `ChangeRequestPurgeRepo`.

---

### 3.37 A Missing Host Token Is Asked For, Never Guessed Around [CRITICAL]

**Rule:** When a host call as the user finds no token, or the host refuses it (TokenNeeded / TokenRejected), the Conversation DO asks the widget for a fresh one (M3-8) and tries the same call once more (`withFreshToken`), but only when a second try can't write twice: nothing may have landed (`mayHaveLanded !== true`), or the call is a resume (the adapter starts a resume's `mayHaveLanded` at true even when it sends nothing; the same plan resends it as a resume). The ask is `HostTokenAsk` (`src/hostToken/`): `token_needed` with `reason: refresh` to every open socket, a wait of at most `HOST_TOKEN_WAIT_MS` for a `host_token` frame (no socket = no wait), shared by every step asking meanwhile, and not repeated for `HOST_TOKEN_WAIT_MS` after one timed out unless a token arrives. A fresh token the host refuses too ends the step as it did before M3-8. A token the host refused is dropped from `this.hostToken` (unless a newer one arrived meanwhile), so the answer, edit and undo gates answer `reason: answer`. A read with no token still tells the model to ask the user to sign in. A commit, read-after, undo or the undo's re-read with no token keeps its entry (`waitForToken`: `tokenNeededSince` from the first wait, `isUnsent` when its first send reached nothing) and resumes on the next `host_token`; `isUnsent` reaches `startCommit` / `startFollowUp` so that resume is a fresh send (never a resend guessing it landed), and it is cleared before every send. A step still waiting `HOST_TOKEN_GRACE_MS` after it first needed the token goes to a person only through `ActionEngineRepo.handOverForToken` (Approved / Committing / Committed / Mismatch → NeedsHuman `token_needed`); a user undo keeps `abandonUndo`. `reason: answer` is only for the reply to the widget's own answer, edit or undo frame (the widget resends that frame once); the widget answers `refresh` silently, with no UI, through `lib/hostTokenSender.ts` (one `getHostToken` call at a time; one that throws, rejects or hangs past `WIDGET_HOST_TOKEN_FETCH_TIMEOUT_MS` never blocks the next send).

**Violations:**

- Ending a commit, read-after or undo Failed / NeedsHuman for a missing or refused token without asking for a fresh one first, or before the grace has passed
- Retrying a fresh (non-resume) host call after a token failure that may have landed, retrying a resume as a fresh send, or retrying more than once per fresh token
- Keeping a token the host refused in `this.hostToken`, or asking the widget again while a timed-out ask's cooldown runs
- A shared widget token fetch that a throwing or hung `getHostToken` can block
- Passing `isUnsent: true` for a step whose last send may have reached the host, or leaving it set across a send
- Sending `token_needed` without `reason`, or `reason: answer` for the DO's own step (the widget would resend an unrelated frame)
- Showing a notice, spinner or card for a `refresh` ask in the widget
- Keeping the waiter or the token anywhere but DO memory (rule 3.11)

**Detection Pattern:**

```regex
type: "token_needed"
WidgetTokenNeededReasonEnum
isUnsent
handOverForToken\(
tokenNeededSince
```

A hit outside `ConversationDO.ts`, `ActionEngineRepo.ts`, `src/hostToken/HostTokenAsk.ts`, `apps/widget/src/hooks/useChangeReview.ts`, `apps/widget/src/lib/hostTokenSender.ts` and `packages/schemas` needs a reason.

**Examples:**

```
- ❌ if (read.outcome === TokenNeeded) return output(Error, TOOL_TEXT.tokenNeeded)   // never asked the widget
- ✅ const { response, isWaiting } = await this.withFreshToken(() => HostToolCallProvider.read(...), { isResume: false, signal })
- ❌ await repo.finishCommit({ hostCall: committed /* TokenRejected, nothing landed */ })   // ends it Failed at once
- ✅ if (isWaiting) await this.waitForToken(toolCallId, !plan.isResume)
```

**Fix:** Mirror `ConversationDO.withFreshToken` / `waitForToken` / `handOverTokenWaits`, `HostTokenAsk`, `ActionEngineRepo.handOverForToken` and the widget's `createHostTokenSender`.

---

### 3.38 Activity Rollups Are Rebuilt Whole, Never Edited [HIGH]

**Rule:** `activity_rollups` is derived (M4-2): a (company, day) is written only by `ActivityRollupsRepo.rebuildDay`, in one `withTenant` that takes the day's advisory lock (`ActivityRollupsDAL.lockActivityRollupDay`), reads the source groups from their own DALs (`ConversationsDAL` / `FeedbackDAL` / `ActivityLogDAL` / `ModelCallsDAL` `get…RollupGroups`), deletes the day and inserts what `ActivityRollupsProvider.buildValues` (pure) returns; any failure rolls the day back. Days are UTC (`Schemas.activityRollupDayKey` / `activityRollupDayRange`), metric keys come only from the `Schemas` helpers (`ACTIVITY_ROLLUP_CONVERSATIONS_STARTED`, `conversationOutcomeMetric`, `ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP`, `changeRequestRollupMetric`, `changeRequestUserUndoRollupMetric`, `modelCallTaskRollupMetric`, `modelCallModelRollupMetric`), every group adds to its chatbot's row and to the company-wide row (`chatbot_id` null), and an eval call (`eval_run_id` set) goes only under the Eval scope's keys (`ActivityRollupModelCallScopeEnum.Eval`, `model_calls.eval.*`), never a chatbot's live usage. Source reads filter on `company_id` + a `created_at` range, so they use `IDX_<table>_company_id_created_at`. Costs are summed in fixed point, never as floats. The hourly `ActivityRollups` cron rebuilds yesterday and today for Active and Paused companies (`rebuildRecent`, company list in `withPlatform`); any other range only through `POST /operator/companies/:companyPublicId/rollups/rebuild` (`authorizePlatform(ActivityRollupRebuild)`, at most `ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS`, nothing after today). Rollups are never a source of truth: a page that must match the raw tables (M4-3 numbers checks) reads them as totals, never writes back.

**Violations:**

- An `UPDATE` / upsert / increment on `activity_rollups`, or an insert outside `ActivityRollupsDAL.createActivityRollups`
- A rebuild that deletes and inserts in separate transactions, or without the day lock
- A metric key built as a literal string outside `packages/schemas/src/activityRollups/`
- Summing `cost_usd` with JS numbers (`Number`, `parseFloat`, `+`)
- A day computed in local time, or a source read filtered on `updated_at` (rows move days on later writes)
- A rollup source read in a DAL other than the source table's own
- Counting an eval call under the live `model_calls.*` keys, or telling eval from live by `chatbot_id` instead of `eval_run_id`
- A day count or range check that lists every day first (use `activityRollupDayCount`)

**Detection Pattern:**

```regex
\.update\(activityRollups\)
insert\(activityRollups\)[\s\S]{0,200}onConflict
["'`](conversations|feedback|change_requests|model_calls)\.[a-z_]+
```

A hit outside `ActivityRollupsDAL.ts`, `providers/activityRollups.ts`, `packages/schemas/src/activityRollups/` and tests needs a reason.

**Examples:**

```
- ❌ await tx.update(activityRollups).set({ value: sql`value + 1` })   // incremental: drifts on a retry
- ✅ await repo.rebuildDay({ companyId, day })   // lock → read → delete → insert, one tx
- ❌ metric: `model_calls.cost.${taskType}`
- ✅ metric: Schemas.modelCallTaskRollupMetric(Measure.CostUsd, taskType)
```

**Fix:** Mirror `ActivityRollupsRepo`, `ActivityRollupsDAL` and `providers/activityRollups.ts`.

---

### 3.39 Insights Pages Read Rollups Through the Parser, One Owner at a Time [HIGH]

**Rule:** Overview, Usage and Impact (M4-3) get their numbers only from `GET /dashboard/insights/{overview,usage,impact}` (`authorizeCompany(InsightRead)`) → `InsightsRepo` (one read-only `withTenant`) → `ActivityRollupsDAL.getActivityRollups`, for one owner: the `botId`'s chatbot (a public id, resolved in the company, unknown → 404) or the company-wide rows (`chatbot_id` null). Metric keys are read back only through `Schemas.parseActivityRollupMetric`; all math lives in the pure `InsightsProvider`. Spend = the `.model.<provider>/<model>` cost keys of company-key providers (live + eval), summed as bigint micros (`ActivityRollupsProvider.toUnits` / `fromUnits`); platform-paid providers (`Schemas.isPlatformPaidProvider`, Workers AI) are "Included", never spend. Periods come only from `Schemas.insightsRangePeriods` / `impactRangePeriods` / `insightsBillingMonth` (UTC); the billing-month spend card always reads the company-wide rows. Readings are indexed by day once (`InsightsProvider.indexReadings`). A tool's Impact work = verified − `user_undone` (the user's undos), never − every `undone` (auto-undos were never verified). Impact's minutes per task are written only by `POST /dashboard/roi-assumptions` (`authorizeCompany(RoiAssumptionUpdate)`, `RoiAssumptionsRepo`): a new `roi_assumptions` row effective today, never an update or delete; a tool task must name one of the company's write tools; each day is valued with `Schemas.roiMinutesOnDay`. The pages never compute a total from raw rows in the browser and never write to `activity_rollups`.

**Violations:**

- A page or Repo reading `model_calls`, `conversations` or `activity_log` directly for an Insights total (the rollup is the read model; raw sums are for tests)
- Adding chatbot rows together for a company total, or reading company and chatbot rows in one query
- Matching a metric key with `startsWith` / a regex / a literal outside `parseActivityRollupMetric`
- A spend total that includes `workers_ai`, or sums `cost_usd` with JS numbers
- A UTC day built with local-time `Date` methods (`getDate`, `setHours`) on the server
- Subtracting `change_requests.undone.*` from verified work, or scanning every reading once per metric or per day
- Putting one bot's spend against the company budget
- An `UPDATE` / `DELETE` on `roi_assumptions`, or minutes for a task saved without the write-tool check
- A component prop type or a page search schema defined in `apps/web` instead of `Schemas.DashboardUi` / `insights/`

**Detection Pattern:**

```regex
metric\.(startsWith|includes|match)\(
\.update\(roiAssumptions\)|\.delete\(roiAssumptions\)
from\(modelCalls\)[\s\S]{0,300}sum\(
```

A hit outside `packages/schemas/src/activityRollups/`, `ModelCallsDAL.ts` (rollup groups, budget seed) and tests needs a reason.

**Examples:**

```
- ❌ const spend = rows.filter((r) => r.metric.includes("cost_usd")).reduce((a, r) => a + Number(r.value), 0)
- ✅ InsightsProvider.buildUsage({ periods, readings: InsightsProvider.parseReadings(rows) })
- ❌ await tx.update(roiAssumptions).set({ manualMinutes })   // rewrites every past day's hours
- ✅ await dal.createRoiAssumption(tx, { …, effectiveFrom: Schemas.activityRollupDayKey(now) })
```

**Fix:** Mirror `InsightsRepo`, `providers/insights.ts`, `RoiAssumptionsRepo` and the `overview/` / `usage/` / `impact/` pages.

---

### 3.40 The Dashboard Transcript Shows No Values; a Turn Costs Its Spend by turn_id [CRITICAL]

**Rule:** The Conversations page (M4-4) reads only through `GET /dashboard/conversations` (list, paged), `/export` and `/:publicId` (`authorizeCompany(ConversationRead)`) → `DashboardConversationsRepo` (one read-only `withTenant` each); a flag only through `POST /dashboard/conversations/:publicId/flag` (`authorizeCompany(QualityIssueCreate)`) → `QualityIssuesRepo.flagConversation`; a change's detail only through `GET /dashboard/change-requests/:publicId` (`authorizeCompany(ChangeRequestRead)`) → `ChangeRequestsRepo`. A transcript never carries a tool call's args, a change's values or a host answer: `tool_calls.encrypted_args` and `change_requests.encrypted_changes` are never selected on these paths and nothing here calls `CompanyKeyProvider.decryptValue`; a tool row shows the tool name, version, status (error codes through `TOOL_CALL_ERROR_LABEL_MAP`) and the change request's value-free `summary`. Turns are grouped and costed only in the pure `ConversationTranscriptProvider`: a turn = one `turn_id` across messages, tool calls and spend model calls; its cost = `SUM(model_calls.cost_usd)` of that `turn_id` with `provider <> 'workers_ai'` (Workers AI is platform-paid, as on the Usage page), summed as bigint micros, Pending / Unknown rows flagged (`ConversationCostNoteEnum`). `botId` / `configId` are public ids resolved in the company (unknown → 404). A flag opens at most one open admin issue per conversation (advisory lock in `QualityIssuesDAL.createAdminQualityIssue`) with its `quality_issue.opened` event in the same transaction (actor Admin), relayed after the commit; the outbox id never reaches the response. A purged conversation keeps its row and costs, never its title or text.

**Violations:**

- Selecting `encryptedArgs`, `encryptedChanges` or `iv` in a dashboard read, or decrypting args or a payload for a dashboard response
- A turn cost that includes `workers_ai` rows, groups by anything but `turn_id`, or sums `cost_usd` with JS numbers
- Building turns, numbering them or adding costs in the browser or the Repo instead of `ConversationTranscriptProvider`
- Sending `turnId`, an internal id, the outbox id or a raw error code without its label to the client
- Opening an admin quality issue without the advisory lock or without its critical event, or relaying it before the commit
- A page component or search schema defined in `apps/web` instead of `Schemas.DashboardUi` / `conversations/`

**Detection Pattern:**

```regex
encrypted(Args|Changes)[\s\S]{0,200}(Dashboard|Transcript)
decryptValue[\s\S]{0,400}(DashboardConversationsRepo|ChangeRequestsRepo)
getConversationTurnCosts[\s\S]{0,600}workers_ai
```

**Examples:**

```
- ❌ toolCalls: rows.map((r) => ({ ...r, args: await decrypt(r.encryptedArgs) }))   // values leave the server
- ✅ ToolCallsDAL.listConversationToolCalls → { toolName, toolVersion, status, errorCode, change: { summary, status } }
- ❌ const turnCost = calls.filter((c) => c.turnId === id).reduce((a, c) => a + Number(c.costUsd), 0)
- ✅ ConversationTranscriptProvider.buildTranscript({ messages, toolCalls, turnCosts })
```

**Fix:** Mirror `DashboardConversationsRepo`, `providers/conversationTranscript.ts`, `QualityIssuesRepo` and the `conversations/` pages.

---

### 3.41 Mark Resolved Only From NeedsHuman, With Its Admin Event; the Changes Page Shows No Values [CRITICAL]

**Rule:** The Changes page (M4-5) reads only through `GET /dashboard/change-requests` (paged; `tab`, `requesterId` = host user id, `botId`, unknown → 404), `/requesters` (capped at `CHANGE_REQUEST_REQUESTERS_MAX`, never in the list's answer), `/needs-human-count` and `/:publicId` (`authorizeCompany(ChangeRequestRead)`) → `ChangeRequestsRepo` (one `withTenant` each). The timeline comes only from the change request's `activity_log` events (`ActivityLogDAL.getActivityLogTimeline`, newest `CHANGE_REQUEST_TIMELINE_MAX_EVENTS` kept, shown oldest first) turned into words by the pure `ChangeRequestTimelineProvider`; event details are read through `Schemas.ZChangeRequestEventDetail`. A change's values (`encrypted_changes`) are never selected or decrypted on these paths. Mark resolved only through `POST /dashboard/change-requests/:publicId/resolve` (`authorizeCompany(ChangeRequestResolve)`) → `ChangeRequestsRepo.resolveChangeRequest`: one `withTenant` that locks the row (`FOR UPDATE OF change_requests`), moves it only from NeedsHuman to Resolved (anything else → `ChangeRequestResolveFailureEnum.NotNeedsHuman`, 409, nothing written), sets `undo_until` through `ChangeRequestsProvider.undoUntil(Resolved)` (now, so the purge empties the values), and records `change_request.resolved` with actor Admin through `CriticalEventProvider.record` (failure → `TenantRollbackError`), relayed after the commit; the answer's detail is read after the commit, so a failed read never rolls the resolve back. Resolved is final: no other code moves a change request out of it.

**Violations:**

- Selecting `encryptedChanges` / `iv` or calling `decryptValue` for a Changes page response
- Resolving without the row lock, from a status other than NeedsHuman, or without its critical event in the same transaction
- Building the timeline's words in the browser or the Repo instead of `ChangeRequestTimelineProvider`, or showing a raw `entity_action`
- Sending an internal id (the change request's, its conversation's, a chatbot user's) or the outbox id to the client
- An uncapped Requested by list, or one rebuilt on every page of the list
- Reading the response's timeline inside the resolve's transaction, or capping the timeline by dropping its newest events

**Detection Pattern:**

```regex
ChangeRequestStatusIntEnum\.Resolved[\s\S]{0,300}fromStatuses:\s*\[(?!Schemas\.ChangeRequestStatusIntEnum\.NeedsHuman\])
decryptValue[\s\S]{0,400}ChangeRequestsRepo
```

**Examples:**

```
- ❌ await dal.updateChangeRequestStatus(tx, { id, status: Resolved, fromStatuses: [row.status] })   // resolves anything
- ✅ getDashboardChangeRequest(tx, { …, isForUpdate: true }) → NeedsHuman only → update + CriticalEventProvider.record
- ❌ timeline: logs.map((log) => ({ label: log.entityAction }))   // internal names in the UI
- ✅ ChangeRequestTimelineProvider.timeline(logs)
```

**Fix:** Mirror `ChangeRequestsRepo.resolveChangeRequest`, `providers/changeRequestTimeline.ts` and the `changes/` pages.

### 3.42 Quality Issues Leave Open Once, With Their Admin Event; a Test Is a Reviewed Rewrite [CRITICAL]

**Rule:** The Quality page (M4-6) reads only through `GET /dashboard/quality-issues` (paged; `tab` open / converted / fixed / dismissed, absent = Open; `botId`, unknown → 404), `/open-count` and `/:publicId` (`authorizeCompany(QualityIssueRead)`) → `QualityIssuesRepo` (one `withTenant` each); the excerpt and the rewrite's input come only from the pure `QualityIssuesProvider` (the rated reply for a user issue, never another reply in its place; nothing once the chat is purged). Every write locks the issue (`getDashboardQualityIssue` with `isForUpdate`), starts only from Open (else `QualityIssueUpdateFailureEnum.NotOpen`, 409, nothing written; a convert whose chatbot is gone: `ChatbotNotFound`, 409) and records its `quality_issue.<triaged|fixed|dismissed|converted>` event with actor Admin through `CriticalEventProvider.record` in the same `withTenant` (failure → `TenantRollbackError`), relayed after the commit; the answer is read after the commit. Triage (`PATCH`, `QualityIssueUpdate`) sets the type and / or note; Mark fixed / Dismiss (`QualityIssueUpdate`) end the issue for good: no code moves an issue back to Open. Create test (`EvalCaseCreate`) is two steps: `POST …/test-draft` reads the chat in one read-only `withTenant`, then calls the model router outside it (the conversation chatbot's published routing, tier Mid, `ModelTaskTypeEnum.QualityTestRewrite`, `conversationId` null so it never adds to the conversation's cost) through `QualityTestRewriteProvider` (chat and note fenced as data, the answer held to `Schemas.ZQualityTestDraft`) and saves nothing; `POST …/convert` takes the admin's reviewed draft and, in one `withTenant`, creates the chatbot's `eval_cases` row (`input` / `expectations` at their own `schemaVersion` 1, never a safety case) and moves the issue to Converted with its `eval_case_id`. Neither the chat, the note nor the draft is logged.

**Violations:**

- A write that skips the row lock or the Open check, or moves an issue back to Open
- A status change or triage without its critical event in the same transaction
- Saving an eval case straight from the model's answer, without the admin's reviewed draft
- Calling a model provider for the rewrite outside the router, or passing the conversation's id to the router for it
- Building the excerpt or the rewrite input in the Repo or the browser instead of `QualityIssuesProvider`, or reading the whole conversation for it (`listConversationMessages`) instead of the bounded `listRecentChatMessages`
- A rewrite input not bounded by `QUALITY_TEST_REWRITE_MAX_CHARS` (the answer restates it under the output cap)
- Logging a note, a message, a draft or an eval case's name / input / expectations

**Detection Pattern:**

```regex
updateQualityIssueStatus\(tx,[\s\S]{0,200}status:\s*Schemas\.QualityIssueStatusIntEnum\.Open
taskType:\s*Schemas\.ModelTaskTypeEnum\.QualityTestRewrite[\s\S]{0,200}conversationId:\s*(?!null)
```

**Examples:**

```
- ❌ const draft = await rewrite(model, source); await evalCasesDal.createEvalCase(tx, { …draft })   // never reviewed
- ✅ POST …/test-draft (draft only) → admin edits → POST …/convert (case + Converted + event, one withTenant)
- ❌ await dal.updateQualityIssueStatus(tx, { id, status: Fixed, … })   // without lockOpenIssue first
- ✅ lockOpenIssue → updateQualityIssueStatus (matches Open) → recordEvent
```

**Fix:** Mirror `QualityIssuesRepo` (`closeQualityIssue`, `draftQualityTest`, `convertQualityIssue`), `providers/qualityIssues.ts`, `providers/qualityTestRewrite.ts` and the `quality/` pages.

---

### 3.43 Gap Clusters Close Once, on a Document of the Company; Removing That Document Reopens Them [CRITICAL]

**Rule:** The Knowledge page (M4-7) reads groups of unanswered questions only through `GET /dashboard/doc-gap-clusters` (paged; `tab` open / answered / dismissed, absent = Open; every tab's count in the same answer; `authorizeCompany(DocGapClusterRead)`) → `DocGapClustersRepo` → `DocGapClustersDAL` (one `withTenant`). Sample questions are only `doc_gaps.question_generic` (already rewritten without personal details), at most `DOC_GAP_SAMPLE_QUESTIONS_MAX` per group, newest first, and never logged. Answer (`POST …/:publicId/answer {documentPublicId}`) and Dismiss (`POST …/dismiss`) (`DocGapClusterUpdate`) lock the group (`getDocGapCluster` with `isForUpdate`), start only from Open (else `DocGapClusterUpdateFailureEnum.NotOpen`, 409, nothing written), and Answer sets `answered_by_document_id` only to a document of the same company, which the Repo reads with `getCompanyKnowledgeDocument({ isForKeyShare: true })` (unknown → 404). That lock holds the document until the commit, so a delete of it can't commit in between and leave the group pointing at a missing document. The group is read back in the same transaction. No code moves a group back to Open by hand. The only reopen is `DocGapClustersDAL.reopenDocGapClustersByDocuments`, called by `KnowledgeDocumentFilesProvider` in the transaction that removes the documents (document delete, source delete, sync prune), so a group never points at a missing document. A source carries an admin-given `name` (`ZKnowledgeSourceName`), set on create and editable by PATCH.

**Violations:**

- Setting `answered_by_document_id` without reading the document in the company under `isForKeyShare`, or from a non-Open group
- Deleting knowledge documents anywhere but `KnowledgeDocumentFilesProvider` (their groups would keep a dangling document)
- Reopening a group from a route or Repo (Open again only when its document is removed)
- Sending `doc_gaps` text other than `question_generic`, or logging it

**Detection Pattern:**

Run these on file content. Each is a violation outside the one file named after it, which the enforcer checks by path (a content regex can't see the file name):

```regex
set\(\{[^}]*status:\s*Schemas\.DocGapClusterStatusIntEnum\.Open
deleteKnowledgeDocuments(BySource)?\(
```

- The first may match only inside `DocGapClustersDAL.reopenDocGapClustersByDocuments` (`data-access-layer/DocGapClustersDAL.ts`).
- The second may be called only from `providers/knowledgeDocumentFiles.ts` (declared in `data-access-layer/KnowledgeDocumentsDAL.ts`).

**Examples:**

```
- ❌ await tx.update(docGapClusters).set({ status: Answered, answeredByDocumentId: id })   // any status, any company's document
- ✅ lockOpenCluster → getCompanyKnowledgeDocument → answerDocGapCluster (matches Open) → readBack
- ❌ await documentsDal.deleteKnowledgeDocuments(tx, { companyId, ids })   // groups it answered keep a missing document
- ✅ await KnowledgeDocumentFilesProvider.remove(tx, { companyId, companyPublicId, documents })
```

**Fix:** Mirror `DocGapClustersRepo`, `DocGapClustersDAL` and `providers/knowledgeDocumentFiles.ts` (`docs/runbooks/knowledge.md`).

### 3.44 Eval Results Are Read Through Their Parsers; Transcripts Never Leave R2 Raw [CRITICAL]

**Rule:** The Tests page (M4-8) reads runs and results only through `GET /dashboard/eval-runs…` (`authorizeCompany(EvalRunRead)`) → `EvalRunsRepo` → `EvalRunsDAL` (one `withTenant`). `eval_results.grader_output` is read only through `Schemas.parseEvalGraderOutput` (`EvalRunsProvider.attempt`); a body that fails it is shown as unreadable (`isGraderOutputUnreadable`), never passed through. A transcript is opened only by `EvalRunsRepo.getEvalRunTranscript`:

- `FilesDAL.getEvalRunTranscriptFile` finds the file inside `withTenant`. It must be `owner_type eval_result`, owned by a result of the run in the URL, and that result's `transcript_file_id` must point back at it; anything else is 404.
- The size is checked against `EVAL_TRANSCRIPT_MAX_BYTES` twice: the row's, then the R2 object's own (`getObject({ maxBytes })`) before its body is read.
- `FileStorageProvider.getObject` reads it outside the transaction.
- `Schemas.parseEvalTranscript` parses it; a file that fails is 422 `Unreadable`.

The client gets the parsed entries only. Raw bytes are never returned or logged, and tool calls carry no args or values. A case's result in a run comes only from `Schemas.evalCaseRunResult` (passed, failed, or null while the run is still grading it: never shown as failed, never counted in the safety tally). A platform case's conversation and rubric are never sent to a company (`body: null`). Cases are written only through `EvalCasesRepo` with bodies built by `Schemas.toEvalCase` (rule 3.50), and read for editing through `Schemas.readEvalCaseBody`. An edit takes the company's own case under its row lock (`getEvalCase({ isForUpdate: true })` matches `company_id`, so a platform case is 404). A body it can't read refuses a new conversation or rubric (409 `NotEditable`). The page never starts a run (M5-2).

**Violations:**

- Returning `grader_output` or a transcript's bytes to a client without its parser, or serving the R2 object directly
- Opening a transcript by file id alone (without the run, the owner result and `transcript_file_id`)
- Writing an eval case's `input` / `expectations` by hand, or editing a platform case
- Deciding a case's result from anything but `evalCaseRunResult`, or returning a platform case's body

**Detection Pattern:**

```regex
graderOutput:\s*row\.graderOutput
FILES_BUCKET\.get\(
```

- The first should match nowhere: an attempt reaches a response only through `EvalRunsProvider.attempt`.
- The second may be called only from `providers/fileStorage.ts`.

**Examples:**

```
- ❌ return c.body(await env.FILES_BUCKET.get(key))                       // raw transcript to the client
- ✅ EvalRunsRepo.getEvalRunTranscript → getEvalRunTranscriptFile → getObject → parseEvalTranscript
- ❌ attempts.map((row) => ({ ...row, graderOutput: row.graderOutput }))  // unparsed jsonb
- ✅ attempts.map((row) => EvalRunsProvider.attempt(row))
```

**Fix:** Mirror `EvalRunsRepo`, `EvalCasesRepo` and `providers/evalRuns.ts` (`docs/runbooks/tests.md`).

### 3.45 An Admin Write Records Its Audit Row in Its Own Transaction [CRITICAL]

**Rule:** Every dashboard and operator write (M4-9) records who did what on what through `recordAuditOrRollback(tx, …)` (`repositories/audit.ts`, the one wrapper of `AuditEventProvider.record`) inside the write's own `withTenant`, after the write succeeded; it throws `TenantRollbackError` when the row fails, so a write never commits without its row. It is a critical event (`activity_log` + `event_outbox`, rule 3.5): never a bare `activity_log` insert. The actor is the Repo's: Admin with the signed-in company admin's `adminId` on a dashboard Repo, Operator on an operator-only Repo (`ToolDefinitionsRepo`), System (`systemAuditActor()`, no id) only for a change no person made on `Schemas.AUDIT_SYSTEM_ENTITY_TYPES` (M5-4: `ChatbotConfigsRepo.applyGateResult`). Entity types and actions come only from `Schemas.AuditEntityTypeEnum` / `AuditEntityActionEnum`; the provider builds the event type and dedupe key (`auditEventType` / `auditEventDedupeKey`, a fresh ULID per call: the key is unique, it never dedupes). The detail is `ZAuditEventDetail` (`label` only: a name, title or task, never chat text, values or secrets). One row per thing that happened (a status change is its own action), none for a save that changes nothing or a refusal. The Repo returns `outboxIds` (`Schemas.WithOutboxIds`); the route takes them off the answer and relays them with `EventOutboxRepo.relayInBackground` after the commit. The log is read only through `/dashboard/audit-log` (`authorizeCompany(AuditLogRead)`) → `AuditLogRepo` → `ActivityLogDAL.getAuditLog` / `getAuditLogCount` (actor Admin or Operator, inlined for the partial index) → `AuditLogProvider` (words and On; no internal id or detail in the answer).

**Violations:**

- A new `/dashboard/*` or `/operator/*` write whose Repo doesn't call `recordAuditOrRollback` in the write's transaction (or records it after the commit), or a Repo calling `AuditEventProvider.record` with its own rollback copy
- Sending `outboxIds` to the client, or not relaying them
- Putting anything but `label` in an audit row's detail, or a label holding chat text, values or secrets
- Recording a row for a refused or no-op write, or for a sync the platform started

**Detection Pattern:**

```regex
c\.json\(\{\s*\.\.\.response,\s*outboxIds
entityType:\s*"(chatbot|knowledge_source|knowledge_document|doc_gap_cluster|eval_case|roi_assumption|tool_definition)"
```

- The first should match nowhere: routes destructure `outboxIds` off the Repo's answer.
- The second should match nowhere: audit entity types are written only as `Schemas.AuditEntityTypeEnum` members.

**Examples:**

```
- ❌ const response = await repo.createChatbot(params); return c.json(response, 201)        // outboxIds to the client, never relayed
- ✅ const { outboxIds, ...response } = await repo.createChatbot(params);
     EventOutboxRepo.relayInBackground(c.env, c.executionCtx, { companyId, outboxIds });
- ❌ await activityLogDal.createActivityLog(tx, { entityType: "chatbot", entityAction: "created", … })   // no outbox row
- ❌ const audited = await AuditEventProvider.record(tx, …); if (!audited.isSuccess) throw new TenantRollbackError(…)   // a copy of the rollback
- ✅ const outboxId = await recordAuditOrRollback(tx, { …, entityType: Schemas.AuditEntityTypeEnum.Chatbot });
```

**Fix:** Mirror `ChatbotsRepo` (`audit`, `updateChatbot`), `repositories/audit.ts`, `providers/auditEvent.ts`, `AuditLogRepo` and `providers/auditLog.ts` (`docs/runbooks/security.md`).

### 3.46 The Security Page Shows Settings, Never Secrets; Its Writes Are Narrow [CRITICAL]

**Rule:** The Security page (M4-9) reads only through `/dashboard/security/*` (`authorizeCompany(SecurityRead)`) into its own view types: `Schemas.SecurityConnection` (no `auth_config`, base URL or internal id; `signingKeysFetchedAt` from `JwksProvider.getCachedFetchedAt`, which reads the cache and never fetches) and `Schemas.SecurityEncryptionKey` (never `encrypted_key` or `master_key_version`). Its writes change one thing each and record their audit row (rule 3.45): allowed origins only (`updateAllowedOrigins`, validated by `ZUpdateAllowedOriginsApiRequest`, compared as a set under the row lock; the issuer is operator-set), a key rotation only through `CompanyEncryptionKeysRepo.rotateCompanyEncryptionKey` (admin-only, key rows locked first; a Retiring key refuses it with 409 `RotationInProgress` through `ENCRYPTION_KEY_ROTATE_FAILURE_HTTP_STATUS_MAP`, nothing written; `rotatedAt` is the next version's `created_at`, never `updated_at`), and retention only to a value in `CONTENT_RETENTION_DAYS_OPTIONS`, compared with the value in force. A save that changes nothing (the same origins in another order, the default saved explicitly) records nothing. No control promises what isn't built: no Erase a user before M6-2, and retention copy says the purge isn't running before M6-1. Prompt-injection events are quality issues typed Prompt injection until M6-4 (`QualityIssuesRepo.getInjectionEvents`).

**Violations:**

- Returning a connection's `authConfig` / `baseUrl`, or a key's `encryptedKey` / `masterKeyVersion`, from a Security route
- Letting a company admin change a connection's `jwt_issuer`, or calling `JwksProvider.getJwks` / a fetch from the Security page's reads
- A rotation, origins or retention write without its audit row, or a rotation that skips the Retiring check
- An Erase a user control, or retention copy that says transcripts are deleted, before M6-2 / M6-1

**Detection Pattern:**

```regex
(encryptedKey|masterKeyVersion|authConfig|baseUrl):\s*(key|connection|row)\.
```

- Should match nowhere in `CompanyConnectionsRepo.toSecurityConnection` or `CompanyEncryptionKeysRepo.getSecurityEncryptionKeys`.

**Examples:**

```
- ❌ return { ...connection, signingKeysFetchedAt }                     // auth settings to the browser
- ✅ CompanyConnectionsRepo.toSecurityConnection(connection)           // environment, issuer, origins, status, cached time
- ❌ await dal.updateCompanyConnection(tx, { jwtIssuer: body.jwtIssuer, … })   // a company admin moving the trust root
- ✅ await dal.updateCompanyConnectionOrigins(tx, { allowedOrigins, updatedBy })
```

**Fix:** Mirror `SecurityRoutes`, `CompanyConnectionsRepo.updateAllowedOrigins`, `CompanyEncryptionKeysRepo.rotateFromDashboard` and `CompaniesRepo.updateContentRetention` (`docs/runbooks/security.md`).

---

### 3.47 Chatbot Versions Are Written Only as Drafts and Published Only With Their Model Keys [CRITICAL]

**Rule:** `chatbot_configs` rows are written only by `ChatbotConfigsRepo` (Settings › Bots, M4-10; the gate run's move through `applyGateResult` in the harness's finish transaction, rule 3.53), each write with its audit row (rule 3.45). A body is stored only through `Schemas.normalizeConfigBody` (`body_hash` = sha256 of its `Utility.stableStringify`), and read for the editor only through `Schemas.readConfigBody` (no platform defaults written back). Only a Draft is saved, discarded or sent to testing (the DAL matches Draft; the Repo locks the row and refuses anything else with 409 `NotDraft`); only a Ready version is published (rule 3.53). One open version (Draft, Testing, Ready) per chatbot, checked under the chatbot row's lock (409 `DraftExists`); rollback is a copy into a new draft, never an edit of an old version. An approval rule whose tools were all unpinned is never saved with an empty list (empty = every tool). Discard archives (configs are never deleted). Publish runs in one `withTenant`: chatbot row locked, version locked and Ready, its gate approval checked (rule 3.53), an Active model key for every routing provider read `FOR SHARE` (`ModelKeyMissing`), every model in `MODEL_PRICES` (`ModelNotPriced`), every pin Active read `FOR SHARE` (`ToolNotActive`), the old Published version archived, this one published; a failure after the archive rolls back (`TenantRollbackError`). Disabling a tool version a Published config pins is refused (409 `PinnedByPublishedConfig`), each Published body read through `readConfigBody` (never matched by its raw jsonb shape). Failures answer `CHATBOT_CONFIG_FAILURE_HTTP_STATUS_MAP`.

**Violations:**

- An insert or update of `chatbot_configs` outside `ChatbotConfigsDAL`, or a `ChatbotConfigsDAL` write called from anywhere but `ChatbotConfigsRepo`
- Storing a body that didn't go through `normalizeConfigBody`, or the output of `loadConfigSpec` (defaults frozen into the row)
- An update that changes a Published or Archived version's body, or a delete of a config row
- A publish or send to testing that skips the model key, price or pin checks, or a publish that archives the old version without rolling back when the publish fails

**Detection Pattern:**

```regex
(insert|update|delete)\(chatbotConfigs\)
```

- Should match only in `ChatbotConfigsDAL.ts` (and test fixtures run as the owner).

**Examples:**

```
- ❌ await tx.update(chatbotConfigs).set({ body: spec })              // loadConfigSpec output, or a published row
- ✅ await this.dal.updateChatbotConfigDraft(tx, { body: normalized.body, bodyHash, … })
- ❌ await dal.publishChatbotConfig(tx, …)                            // no key / pin checks
- ✅ const refused = await this.checkPublishNeeds(tx, { companyId, body }); if (refused) return refused;
```

**Fix:** Mirror `ChatbotConfigsRepo` (`docs/runbooks/bots.md`).

---

### 3.48 A Model Key Is Saved Only After the Provider Accepts It, and Never Leaves the Repo [CRITICAL]

**Rule:** Settings › Model keys (M4-10) writes model keys only through `CompanySecretsRepo.addModelKey` / `rotateModelKey`. The pasted key is checked first with `AiGatewayProvider.checkModelKey` (the provider's list-models GET through AI Gateway: no model call, nothing billed; outside any transaction), and only `Valid` saves anything: `Rejected` (the router's own rejected-key rule, `isRejectedKeyAnswer`, never a 403 or a gateway error) answers 400 `KeyRejected`, anything else 502 `CheckUnavailable`. One Active key per provider (pre-checked, and the unique index's violation mapped through `isActiveKeyTaken`) → 409 `ProviderHasActiveKey`. A rotation locks the row, encrypts the new value with `CompanyKeyProvider.encryptValue`, and sets it Active with `last_validated_at`. Each write has its audit row (rule 3.45) labelled with the provider. The key goes only into the provider's auth header on that check and into the encryption call; it is never logged, never in a DAL param, never in an answer (`Schemas.ModelKey` carries `lastFourChars` only). The spending budget is written only by `CompaniesRepo.updateSpendingBudget` (`ZSpendingBudgetUsd`: positive, whole cents, capped; compared in micro-dollars with the value in force under the row lock, so the amount already in force records nothing; `BudgetChanged` audit row); "used" is the same `model_calls` sum BudgetDO is seeded from.

**Violations:**

- Saving or rotating a model key without a `Valid` check, or making the check a model call (anything but list-models)
- Treating a 403 or a gateway error as a rejected key
- A model key's plaintext in a log, a DAL param or a route response
- A budget write outside `CompaniesRepo.updateSpendingBudget`, or one that records an audit row when the amount didn't change

**Detection Pattern:**

```regex
checkModelKey|spendingBudget:\s
```

- `checkModelKey` should be called only from `CompanySecretsRepo.ts`; a `spendingBudget` write only from `CompaniesDAL.updateCompanySpendingBudget`.

**Examples:**

```
- ❌ await this.dal.createCompanySecret(tx, { …, encryptedSecret })   // no provider check first
- ✅ const outcome = await AiGatewayProvider.checkModelKey(this.env, { provider, apiKey }); if (refusal) return refusal;
- ❌ AppLogger.error({ …, metadata: { provider, apiKey } })
- ✅ AppLogger.error({ …, metadata: { provider } })
```

**Fix:** Mirror `CompanySecretsRepo.addModelKey` / `CompaniesRepo.updateSpendingBudget` (`docs/runbooks/model-keys.md`, `docs/runbooks/budget.md`).

---

### 3.49 An Admin Invite Is a Row, and the Row Decides Who Gets In [CRITICAL]

**Rule:** Company admins are invited only through `TeamRepo.inviteAdmin` (Settings › Team, M4-10). Its checks and the `admin_invites` insert (Pending, one per company and email) run in a `withTenant` holding the company row lock and commit before Clerk is called; Clerk is never called inside a transaction. Then Clerk gets an emailed invitation (new email) or the invite metadata on an existing account that administers no company and holds no other invite metadata, and a second `withTenant` stores the Clerk reference and the audit row. A Clerk failure closes the row as Revoked. The Clerk metadata carries `{ companyPublicId, adminInvitePublicId }`; `AdminsRepo.provisionAdmin` creates an admin from it only while that invite row is Pending in the named company, locking it and marking it Accepted in the admin row's transaction (a failed admin insert rolls the acceptance back), and clears the metadata after refusing a Revoked or unknown invite. Revoke commits Revoked (Pending only) with its audit row, then tells Clerk, best effort. Remove admin never deletes the row: `removed_at` / `removed_by` are set and `clerk_user_id` is replaced by a `removed_` token, so the person stays named on what they did; never yourself or the last admin, under the company lock. Every write has its audit row (rule 3.45). Emails never go into log metadata.

**Violations:**

- Creating a Clerk invitation or setting `companyPublicId` metadata from code anywhere but `ClerkProvider.createInvitation` / `grantInvite`, called by `TeamRepo`
- A Clerk call inside a `withTenant` / `withPlatform` callback
- Provisioning an admin from `adminInvitePublicId` metadata without locking the invite row and checking it is Pending in the same company
- Deleting an `admins` row from app code, or a removal without the self / last-admin checks under the company lock

**Detection Pattern:**

```regex
createInvitation|updateUserMetadata|delete\(admins\)
```

- `createInvitation` / `updateUserMetadata` should appear only in `providers/clerk.ts`; `delete(admins)` only in test fixtures run as the owner.

**Examples:**

```
- ❌ await withTenant(db, companyId, async (tx) => { …; await ClerkProvider.createInvitation(env, …) })   // Clerk under a lock
- ✅ const created = await withTenant(…insert Pending…); const sent = await ClerkProvider.createInvitation(env, { …, adminInvitePublicId }); await withTenant(…ref + audit…)
- ❌ await tx.delete(admins).where(eq(admins.id, adminId))                  // erases who did what
- ✅ await this.adminsDal.removeAdmin(tx, { companyId, adminId, removedBy })
```

**Fix:** Mirror `TeamRepo` and `AdminsRepo.provisionAdmin` (`docs/runbooks/team.md`).

### 3.50 Eval Cases Are Read Through Their Loader, and the Python Types Are Generated [CRITICAL]

**Rule:** `eval_cases.expectations` (M5-1) is read only through `Schemas.loadEvalCaseExpectations` (or `readEvalCaseBody`, which uses it). That loader upgrades the body from its own `schemaVersion` with the registered upgraders and holds it to the current schema. It never throws and never writes the upgraded body back. Expectations are written only through `Schemas.toEvalCase`, at the current version. It returns `{ isSuccess: false, failure }` (`EvalCaseWriteFailureEnum`: NothingToCheck, TooLong, Invalid) instead of storing anything, and a refusal is reported by that reason (`EVAL_CASE_UPDATE_FAILURE_BY_WRITE_FAILURE`), never guessed. Whether a case checks anything besides its rubric is decided only by `Schemas.hasEvalCaseChecks`. `input` stays `ZEvalCaseInputV1`. A shape change adds `ZEvalCaseExpectationsV<n+1>`, registers the upgrader from `n` with a test, and never edits a released version. The dashboard edits a case's name, conversation and rubric only. An edit keeps the stored checks (rules, tool calls, forbidden tools, readbacks) and is refused when it would leave nothing to check (409 `NothingToCheck`) or make the expectations too long (400 `TooLong`). The Python harness gets its types only from generated code: `evals/diletta_evals/types/` is written by `pnpm evals:types` from `evals/schemas/`. Never edit it by hand. Every change to a `JSON_SCHEMA_EXPORTS` schema or a contract sample regenerates the JSON Schema, the fixture and the types in the same PR. `pnpm evals:check` (the `Evals Contract` workflow) fails until it does.

**Violations:**

- Parsing `eval_cases.expectations` with `ZEvalCaseExpectationsV*.parse` / `safeParse` outside `packages/schemas`, or writing a body that `toEvalCase` didn't build
- Writing an upgraded body back to a row nobody edited, or editing a released `ZEvalCaseExpectationsV<n>`
- Dropping a case's rules, tool calls, forbidden tools or readbacks on a dashboard edit
- A hand edit to `evals/diletta_evals/types/`, or a schema / sample change without the regenerated `evals/schemas/`, `evals/fixtures/` and `evals/diletta_evals/types/`
- Python types for a case shape written by hand in `evals/`, or upgrade logic for old case versions in Python (the harness gets cases already upgraded)

**Detection Pattern:**

```regex
ZEvalCaseExpectationsV\d+\.(safeParse|parse)\(|expectations:\s*\{\s*schemaVersion
```

- Both should match only inside `packages/schemas/src/evalCases/` and in test fixtures.

**Examples:**

```
- ❌ const expectations = row.expectations as Schemas.EvalCaseExpectations          // skips the upgrade from v1
- ✅ const body = Schemas.readEvalCaseBody(row.input, row.expectations)
- ❌ expectations: { schemaVersion: 2, rubric }                                       // hand-built, no refinements
- ✅ const stored = Schemas.toEvalCase({ messages, rubric, checks: body.checks }); if (!stored.isSuccess) return { failure: EVAL_CASE_UPDATE_FAILURE_BY_WRITE_FAILURE[stored.failure] }
```

**Fix:** Mirror `EvalCasesRepo` and `EvalCasesCommon.ts`, then run `pnpm --filter @app/schemas schema:export && pnpm evals:types && pnpm evals:check` (`docs/runbooks/tests.md`).

---

### 3.51 /eval/\* Takes Only a Platform-Signed Eval JWT, on a Staging Connection [CRITICAL]

**Rule:** Every `/eval/*` route (M5-2) runs `authenticateEval` first, before any validator, and nothing else: no Clerk session, no widget JWT. The token is verified only by `EvalAuthRepo.authenticate`: `EvalJwtProvider` (ES256, a `kid` from `EVAL_JWT_PUBLIC_JWKS`, `iss` / `aud` / lifetime), then the company and connection it names, and the connection must be an active **Staging** one of an active company (a production connection is 403). The company and connection come from the token, never from a body or path. A run is held to what it started with: `eval_runs.eval_case_ids` (the cases `startRun` handed out) and `company_connection_id` (the token's staging connection). A step whose token names another connection is 404, a result or attempt for a case outside the set is 404, Done needs k results for every case of the set (`case_count` = its size) and a reset that went through (`reset_at`), and each step that writes (attempt start, result, finish) reads the run row `FOR UPDATE`. An attempt runs once: `conversations (eval_run_id, eval_case_id, eval_attempt)` is unique, so a repeat is 409 `Duplicate` before any model call. `cost_usd` is added to by every model call of the run as it is recorded or backfilled (`EvalRunsDAL.addEvalRunCost`), never summed at the finish. An eval conversation is marked by `session.eval` and `conversations.eval_run_id`; the widget never resumes one (`startOrResume` and `onConnect` refuse it), and a key failure in it opens no Quality issue. Its turns are held to the company's budget, never to a user's (no `admitTurn`, no chatbot user on its model calls). `decideApproval` stays the policy: a Required write is approved by the eval on its test user's behalf (`isApprovedByEval`, logged as an eval approval, never as automatic) and the attempt answers it as `wasApprovalRequired`. It runs the run's config, never the published one. Its host calls run only on the token's staging connection (`evalConnectionId` in place of the tool version's own connection, joined only when it is Staging). Its model calls carry `evalRunId`. Its writes are approved without a user, and a Blocked rule still blocks. It never shows on the dashboard: every dashboard read and rollup of conversations or change requests filters `eval_run_id IS NULL`. The harness's host bearer (`X-Host-Token`) goes only to DO memory or the adapter (rule 3.11). A connection's `reset_op` is a `ZConnectionResetOp` and exists only on a Staging connection.

**Violations:**

- An `/eval/*` route without `authenticateEval`, or one that reads the company or connection from the request
- Accepting an eval JWT for a Production connection, verifying it against a host's JWKS, or accepting another algorithm than ES256
- A host call of an eval conversation that runs on the tool version's own connection, or an eval turn that loads the published config
- A dashboard query of `conversations` or `change_requests` (list, count, detail, rollup) without `isNull(conversations.evalRunId)`
- Logging, storing or echoing `X-Host-Token`; a `reset_op` on a Production connection
- Finishing a run Done from the cases that have results instead of `eval_case_ids`, recording a case outside the set, or a run step that doesn't check `company_connection_id`
- A widget resume or socket connect that admits an eval conversation (`evalRunId` / `session.eval` set)
- Overriding the approval decision for an eval (`isApprovalRequired = … && session.eval === null`) instead of `isApprovedByEval`, or logging an eval approval as `isAutomatic`
- A Done finish without `reset_at`, or an attempt that can start twice for one (run, case, attempt)

**Detection Pattern:**

```regex
EvalHarnessRoutes\.(get|post|put|patch|delete)\((?![^)]*authenticateEval)
```

- In `durable-objects/ConversationDO.ts` only: `evalRunId:\s*null` is a violation (it must come from `session.eval`). Elsewhere it is legitimate (knowledge calls, a user's quality issue), so scope the search to that file.

**Examples:**

```
- ❌ EvalHarnessRoutes.post("/runs", zValidator("json", Schemas.ZCreateEvalRunApiRequest), handler)
- ✅ EvalHarnessRoutes.post("/runs", authenticateEval, zValidator("json", Schemas.ZCreateEvalRunApiRequest), handler)
- ❌ const conditions = [eq(conversations.companyId, params.companyId)]                // a dashboard list that shows eval chats
- ✅ const conditions = [eq(conversations.companyId, params.companyId), isNull(conversations.evalRunId)]
```

**Fix:** Mirror `EvalHarnessRoutes` / `EvalHarnessRepo` and `ToolDefinitionsDAL.runConnectionJoinConditions` (`docs/runbooks/evals.md`).

---

### 3.52 The Eval Judge Is Pinned and Routed; a Transcript Is Built by the Backend [CRITICAL]

**Rule:** The LLM judge (M5-3) runs only in the backend, through `POST /eval/runs/:runId/judge` → `EvalJudgeRepo.judge` → `ModelRouterRepo.getModel` (`taskType` `EvalJudge`, the run's `evalRunId`, the attempt's conversation, no chatbot user, no caps) → `EvalJudgeProvider`. Its model is `Schemas.pickEvalJudgeModel(routing)`: of the two pinned models of the run config's default tier's provider (`EVAL_JUDGE_MODELS[provider]`), the primary unless a tier of the config names it, then the alternate, so the config never picks its judge and a model never grades its own replies. Both pinned models of every provider are in `MODEL_PRICES` and differ. A change to the judge's prompt bumps `EVAL_JUDGE_PROMPT_VERSION`. The judge reads `EvalTranscriptProvider.judgeView` (every tool call, the last reply whole, held to `EVAL_JUDGE_TRANSCRIPT_MAX_CHARS`), never the stored file's cut-down v1. The view and rubric reach the model fenced as data (`EvalJudgeProvider.prompt`, tags defused). The judge never takes the transcript from the harness: the backend reads the attempt from its DO (`EvalTranscriptsRepo.read` → `getEvalTranscript`, eval sessions only, once the DO is idle). Any failure to get a verdict (router, provider, gateway, budget, an answer that won't parse after `EVAL_JUDGE_MAX_TRIES`) is `JudgeUnavailable` (503), never a pass and never a fail verdict. The harness never retries it: it records that attempt failed with the reason, stops the run, resets, and finishes it Failed with `failure` `JudgeUnavailable` (`eval_runs.failure`, only on an incomplete run). `/results` answers Duplicate before any DO read or R2 write when the attempt has its result (`EvalRunsDAL.hasEvalResult`). An attempt's transcript is built by `EvalTranscriptProvider.build` (v1: messages, and pinned tool calls with version, status and change summary, never args or values) and stored by `EvalTranscriptsRepo.store`: the `files` row pending its owner (`FILE_PENDING_OWNER_ID`, its own transaction) **before** the R2 object, then attached in the result's transaction (`EvalTranscriptFilesProvider.attach`). It is discarded only when that transaction is known not to have written the result; an unknown outcome is left to the hourly `EvalTranscriptSweep`, which removes rows still pending after `EVAL_TRANSCRIPT_PENDING_MAX_AGE_MS` with their objects. Both remove rows first, through a delete that re-checks they are still pending (`deleteFiles` `pendingOwnerType`), then only the objects of the rows actually removed. No refusal is told apart by its message text. `eval_runs.failure` names what actually stopped the run (`stop_reason`): ServerError only for a backend 5xx or no answer, HarnessError for the harness's own stops.

**Violations:**

- A judge model call from Python, from `evals/`, or anywhere but `EvalJudgeRepo.judge` through the model router
- A judge model taken from the config's routing (`routing[tier].model`) or `EVAL_JUDGE_MODELS` directly instead of `pickEvalJudgeModel`, or a pinned model missing from `MODEL_PRICES`
- A `/judge` or `/results` body that carries the transcript, or a transcript with tool args or host values
- Grading a rubric as passed (or failed) when the judge gave no verdict, or retrying `JudgeUnavailable` in the harness
- An `eval_results` row pointing at a transcript file that isn't in R2, or an R2 transcript left behind by a refused result
- An R2 transcript put before its pending `files` row exists, deleting a transcript when the result's commit outcome is unknown, deleting a transcript row without re-checking it is still pending (or its object before its row), or deciding a refusal by comparing `message` strings
- The judge graded on `EvalTranscriptProvider.build`'s stored transcript, or a judge prompt with no size budget
- `failure` set on a Done run

**Detection Pattern:**

```regex
ModelTaskTypeEnum\.EvalJudge
```

- As a model call's `taskType`, legitimate only in `repositories/EvalJudgeRepo.ts` (and tests); the Insights usage label map (`InsightsCommon.ts`) only names it. Anywhere else is a violation.

**Examples:**

```
- ❌ const pinned = source.routing[source.routing.defaultTier]                        // the config's own model judges itself
- ✅ const pinned = Schemas.pickEvalJudgeModel(source.routing)
- ❌ return { verdict: { hasPassed: false, reason: "Judge unreachable" } }             // a made-up verdict
- ✅ return refuse(Schemas.EvalRunStepFailureEnum.JudgeUnavailable, message)
```

**Fix:** Mirror `EvalJudgeRepo.judge`, `EvalHarnessRepo.recordResult`, `EvalJudgeProvider` and `EvalTranscriptProvider` (`docs/runbooks/evals.md`).

---

### 3.53 A Version Goes Live Only Through Its Gate; a Failed Safety Case Blocks It [CRITICAL]

**Rule:** The publish gate (M5-4): Draft → Testing only by an admin (`ChatbotConfigsRepo.sendChatbotConfigToTesting`, its publish needs checked, audited `SentToTesting`); Testing → Ready / Draft only by the finish of a Gate run, through `ChatbotConfigsRepo.applyGateResult(tx, …)` in the finish's transaction (`EvalHarnessRepo.finish`, run row then config row locked), only while the config is still Testing and was sent no later than the run started (`chatbot_configs.updated_at` and `eval_runs.created_at` both `clock_timestamp()`, taken after their row locks, never the transaction's `now()`), audited as System (`PassedGate` / `FailedGate`); Testing / Ready → Draft only by an admin (`moveChatbotConfigToDraft`, clears `approved_by_run_id`, audited `MovedToDraft`); Ready → Published only by `publishChatbotConfig`. Every move goes through `ChatbotConfigsDAL.moveChatbotConfigStatus` (matches its `fromStatuses`) or `publishChatbotConfig` (matches Ready). `POST /eval/runs` with trigger Gate needs `k ≥ Schemas.EVAL_GATE_MIN_K` (400 `Invalid`) and a Testing config (409 `NotTesting`, config row locked); Manual and Nightly runs never move a config. A run's `has_passed` comes only from `Schemas.evalRunGateDecision` over every case of its set (tallies from `eval_cases`, a case that never ran = 0 attempts): Done, at least `EVAL_GATE_PASS_PERCENT` of the set passed pass^k, **and** every safety case of the set passed all k (one failed or never-run safety case fails it, above the threshold too). Publish refuses (409) a version that isn't Ready (`NotReady`), whose `approved_by_run_id` isn't its own Done passed **Gate** run with `k ≥ EVAL_GATE_MIN_K` (`NotApproved`), or whose chatbot has an active safety case (its own or the platform's) outside that run's `eval_case_ids` or updated after it started (`GateOutdated`); its publish needs are checked again. The editor's safety banner reads the newest Gate run only, on a draft only.

**Violations:**

- A `status` or `approved_by_run_id` write on `chatbot_configs` outside `moveChatbotConfigStatus` / `publishChatbotConfig`, or a publish that matches any status but Ready
- `has_passed` computed anywhere but `evalRunGateDecision` (e.g. `passAllKCount === caseCount`, or a threshold with no safety rule)
- A Gate run started on a config that isn't Testing or with `k < EVAL_GATE_MIN_K`, a Manual or Nightly run that moves its config, a finish that moves a config sent after the run started, or a gate move compared on `now()`
- A gate move outside `ChatbotConfigsRepo.applyGateResult` (e.g. `EvalHarnessRepo` calling `ChatbotConfigsDAL` itself), or one without its System audit row
- A publish that skips `checkGateApproval`, or trusts `approved_by_run_id` without reading the run (Gate, Done, passed, `k ≥ EVAL_GATE_MIN_K`, same config) and the active safety cases

**Detection Pattern:**

```regex
approvedByRunId:|passAllKCount === |ChatbotConfigStatusIntEnum\.Ready
```

- `approvedByRunId:` in a write only in `ChatbotConfigsDAL.moveChatbotConfigStatus` (and owner test fixtures); `passAllKCount === ` nowhere in a pass decision.

**Examples:**

```
- ❌ hasPassed: request.isComplete && passAllKCount === caseIds.length       // no safety rule
- ✅ const gate = Schemas.evalRunGateDecision({ isComplete, k, caseCount, cases })
- ❌ await this.lockDraft(tx, …); await this.dal.publishChatbotConfig(tx, …) // a draft goes live untested
- ✅ lockVersion(Ready) → checkGateApproval → checkPublishNeeds → publish
```

**Fix:** Mirror `ChatbotConfigsRepo.publishChatbotConfig` / `checkGateApproval` / `applyGateResult` and `EvalHarnessRepo.finish` (`docs/runbooks/bots.md`, `docs/runbooks/evals.md`).

---

### 3.54 Platform Cases Come Only From Code; the Nightly Suite Alerts From the Backend Too [HIGH]

**Rule:** The platform suite (M5-5). A platform eval case (`company_id` null) is written only by `PlatformEvalCasesRepo.sync` (the hourly `PlatformEvalCaseSync` cron, `withPlatform`, one transaction, rolled back whole on any failure) from `Schemas.PLATFORM_EVAL_CASES` through `loadPlatformEvalCases` (`toEvalCase` + input v1 + key and name checks, all or nothing), matched by `eval_cases.platform_key` (unique, platform rows only: `CHK_eval_cases_platform_key`): new → inserted, changed or off → rewritten and turned on, removed → turned off, except a safety case, which stays as it is and alerts, as does one code demotes (`PlatformEvalCaseSyncProvider.plan`). Tests sync only their own prefixed definitions. Platform cases name no tool or record (every company's gate runs them); cases on the test host's tools are the test company's own (`Schemas.TEST_HOST_EVAL_CASES`, written by `pnpm --filter test-host seed`). `POST /eval/runs` names exactly one of `chatbotConfigId` / `chatbotId` (the chatbot's published config at the start, else 409 `NoPublishedConfig`), and a Gate run only by `chatbotConfigId`. A Nightly run that finishes without passing alerts after its commit (`NightlySuiteAlertProvider`, error log); the daily `NightlySuiteCheck` cron alerts when `NIGHTLY_SUITE_COMPANY_ID` (staging only) has no Nightly run Done within `Constants.NIGHTLY_SUITE_MAX_AGE_MS`. The suite runs only from `.github/workflows/nightly-evals.yml` on the staging environment, never against a production connection.

**Violations:**

- An insert or update of an `eval_cases` row with `company_id` null outside `EvalCasesDAL.*PlatformEvalCase*` (a seed, a migration or an operator route writing platform cases), or a platform case that names a tool
- A sync that writes some cases when one is invalid, turns a platform safety case off, or demotes one
- A test that syncs the real `PLATFORM_EVAL_CASES` into staging
- `platform_key` on a company's case, or a company case matched by it
- A Gate run started by `chatbotId`, or a run by `chatbotId` that falls back to a draft when nothing is published
- A Nightly run failure or a missed night that only the GitHub job reports (no backend alert)

**Detection Pattern:**

```regex
platformKey|companyId: null|PLATFORM_EVAL_CASES|trigger.*Nightly
```

- `companyId: null` in an `evalCases` insert only in `EvalCasesDAL.createPlatformEvalCase` (and owner test fixtures).

**Examples:**

```
- ❌ await ownerDb.insert(evalCases).values({ companyId: null, name: "No secrets", … })   // in a seed or migration
- ✅ add it to Schemas.PLATFORM_EVAL_CASES; the next PlatformEvalCaseSync writes it
- ❌ { platformKey: "safety.x", body: { …, checks: { toolCalls: [{ toolName: "update_record", … }] } } }
- ✅ a test-host tool case in Schemas.TEST_HOST_EVAL_CASES (the test company's own)
```

**Fix:** Mirror `PlatformEvalCasesRepo.sync`, `NightlySuiteRepo` and `EvalHarnessRepo.runConfigTarget` (`docs/runbooks/nightly-suite.md`).

---

### 3.55 Production Health Is Judged From Live Rollups and Opens One Chatbot-Wide Issue [HIGH]

**Rule:** Daily production health per chatbot (M5-5). The judgement is only `Schemas.chatbotHealthCounts` + `evaluateChatbotHealth` over the chatbot's live `activity_rollups` (yesterday vs the `CHATBOT_HEALTH_BASELINE_DAYS` before it; volume floor on both sides; `CHATBOT_HEALTH_MIN_RISE_POINTS` rise), run by `ChatbotHealthRepo` from the daily `ChatbotHealthCheck` cron (`withPlatform` to list companies only, `withTenant` per company and per drop). A drop is written only through `ChatbotHealthProvider.record(tx, …)`: one open chatbot-wide System issue per chatbot (advisory lock on the chatbot, found by source + no conversation + chatbot, never by the `issue_type` an admin can rewrite), `conversation_id` null and `chatbot_id` set, a day recorded once (`hasChatbotHealthDay` on its events, never from the editable note or a capped read), the note held to `QUALITY_ISSUE_NOTE_MAX_CHARS` (`appendChatbotHealthNote`), each write with its critical event, and a newly recorded drop logs an error. Every `quality_issues` insert sets `chatbot_id`; Quality reads (list, counts, chatbot filter, open counts) use `quality_issues.chatbot_id`, never the conversation's. Only a System issue may have no conversation (`CHK_quality_issues_system_conversation_id`), and such an issue never becomes a test (409 `NoConversation`).

**Violations:**

- A health signal computed from raw tables, from eval conversations, or with its own threshold instead of `evaluateChatbotHealth`
- A Health drop issue opened outside `ChatbotHealthProvider`, a second open one for a chatbot, or a day's sentence added twice
- A `qualityIssues` insert without `chatbotId`, or a Quality read that filters by `conversations.chatbotId`
- A UI that decides "chatbot-wide" from a missing `conversation` instead of `isChatbotWide`, or a Quality read that returns an issue whose conversation row is gone

**Detection Pattern:**

```regex
HealthDrop|conversations\.chatbotId|insert\(qualityIssues\)
```

**Examples:**

```
- ❌ if (downCount / total > 0.3) createSystemQualityIssue(...)        // own threshold, no baseline
- ✅ const drops = Schemas.evaluateChatbotHealth({ day, baseline }); ChatbotHealthProvider.record(tx, {...})
- ❌ if (params.chatbotId) conditions.push(eq(conversations.chatbotId, params.chatbotId))
- ✅ if (params.chatbotId) conditions.push(eq(qualityIssues.chatbotId, params.chatbotId))
```

**Fix:** Mirror `ChatbotHealthRepo`, `ChatbotHealthProvider` and `QualityIssuesDAL.dashboardConditions` (`docs/runbooks/health.md`).

---

### 3.56 Doc Gaps: Stripped Text Only, Clustered per Chatbot, One Quality Item per Group [HIGH]

**Rule:** Doc gaps (M5-6). A candidate is only `Schemas.docGapCandidateSignal` on a live turn, recorded in `ConversationsRepo.recordTurn` as a `doc_gap.candidate` critical event with ids only. Only `DocGapsRepo.processCandidate` (from `EventsConsumer`) writes `doc_gaps` and grows or creates `doc_gap_clusters`, with no transaction across a model call, under the chatbot's clustering lock. `question_generic` comes only through `DocGapRewriteProvider` + `Schemas.parseDocGapRewrite`; chat and question text are never logged and never put in an event. The rewrite goes through the model router (`doc_gap.rewrite`), the embedding through `KnowledgeEmbedProvider` (`doc_gap.embed`) with its `model_calls` rows. A group joins only Open or Dismissed groups of the same chatbot at `DOC_GAP_CLUSTER_MIN_SIMILARITY`. A Quality item opens only through `DocGapQualityProvider.open` when `Schemas.docGapClusterOpensQualityIssue` says so, one per group ever; never one per question. `getOpenChatbotWideQualityIssue` excludes these items. Closing a group closes its open item in the same transaction.

**Violations:**

- Storing, logging or sending raw chat text as a gap, or a `question_generic` that skipped `parseDocGapRewrite`
- A candidate from an eval turn, or chat text in the candidate event
- Holding a `withTenant` open across the rewrite or the embed
- An `insert(docGaps)` / `insert(docGapClusters)` outside `DocGapsDAL` / `DocGapClustersDAL`, or a clustering write without `lockDocGapClustering`
- Matching an Answered group, or another chatbot's
- A Quality item per question, a threshold other than `docGapClusterOpensQualityIssue`, or a second item for a group

**Detection Pattern:**

```regex
insert\(docGaps\)|insert\(docGapClusters\)|questionGeneric:|docGapClusterId:
```

**Examples:**

```
- ❌ await createSystemQualityIssue(tx, { ...gap })                   // an item per question
- ✅ if (Schemas.docGapClusterOpensQualityIssue(counts)) await DocGapQualityProvider.open(tx, params)
```

**Fix:** Mirror `DocGapsRepo`, `providers/docGapRewrite.ts` and `providers/docGapQuality.ts` (`docs/runbooks/knowledge.md`).

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
Updated: 2026-10-06 (M0-6: section 3 Companion platform rules, UI rules 2.2–2.6; M0-7: 3.14 master key; M1-3: RLS, 3.15 withPlatform, 3.16 table grants); 2026-10-07 (M1-4: 3.17 paged lists, 3.18 where clauses; M1-5: 1.1 provider → DAL, 3.19 envelope encryption); 2026-10-08 (M1-7: 3.12 config spec versions, loader / normalizer, platform defaults, evals/schemas export; M1-8: 3.20 can() on every dashboard and operator route, 3.3 companyId from authorizeCompany, users table dropped); 2026-10-08 (M1-9: 3.21 owner rights only through SECURITY DEFINER functions; M2-1: 3.22 widget identity from a verified companion JWT, 3.3 issuer lookup named; M2-3: 3.10 router files, price table, key-failure rules); 2026-10-09 (M2-2: 3.22 auth before the upgrade (ADR 0001), 3.23 Conversation DO server-authoritative; 1.1 self-contained tx-step providers, 3.10 retries, 3.23 init-before-check, sync by id; M2-4: 3.24 every model call reserved against the budget; M2-5: 3.10 Workers AI embed and toMarkdown files, 3.25 knowledge ingestion); 2026-10-10 (M2-6: 3.10 rerank file and KnowledgeModelCallsProvider, 3.23 search_help_docs the only tool, 3.25 provider rename, 3.26 knowledge search); 2026-10-10 (M2-7: 3.22 /widget/bootstrap + widget CORS, 3.23 feedback frame, 3.27 widget renders data, never trusts it); 2026-10-10 (M2-7 review: 3.22 query after token on /widget/\*, 3.23 feedback status re-check, rate limit and ordering, 3.27 hashed host user, idle after a dropped resume, widget tokens); 2026-10-10 (M2-8: 3.28 a thumbs-down opens its user issue in the rating's transaction); 2026-10-10 (M3-1: 3.29 tool ops versioned, rendered only by renderToolOp, operator-curated); 2026-10-10 (M3-2: 3.30 host calls only through @app/adapter, emulated tools off {result.\*}); 2026-10-10 (M3-3: 3.31 the test host stays a test fixture); 2026-10-11 (3.32 one cron trigger per Worker, jobs picked by time); 2026-10-11 (M3-4: 3.33 host tool calls through the action engine, 3.23 host tools and the action frames); 2026-10-11 (M3-4 review: 3.33 nested args, full diff, blocked rules, decision claim, deadline, step failures, token-gated resume; 3.23 decision frame limit); 2026-10-21 (M3-5: 3.34 edits re-checked like a new proposal, batch answers resolved together; 3.23 batch and edit frames); 2026-10-22 (M3-6: 3.35 a commit counts only once its read-after verifies it, auto-undo per change request); 2026-10-22 (M4-1: 2.7 dashboard shell, nav and page header); 2026-10-23 (M4-2: 3.38 activity rollups rebuilt whole, never edited); 2026-10-23 (M4-3: 3.39 Insights pages read rollups through the parser, ROI minutes append-only); 2026-10-23 (M4-4: 3.40 dashboard transcript shows no values, turn cost = spend by turn_id, one open admin flag); 2026-10-24 (M4-5: 3.41 Mark resolved only from NeedsHuman with its admin event, Changes page shows no values); 2026-10-24 (M4-6: 3.42 quality issues leave Open once with their admin event, a test is a reviewed rewrite); 2026-10-24 (M4-7: 3.43 gap clusters close once on a company document, removing it reopens them); 2026-10-25 (M4-8: 3.44 eval results read through their parsers, transcripts never leave R2 raw); 2026-10-25 (M4-9: 3.45 an admin write records its audit row in its own transaction; 3.46 the Security page shows settings, never secrets, and its writes are narrow); 2026-10-26 (M4-10: 3.47 chatbot versions written only as drafts, published only with their model keys); 2026-10-28 (M4-10: 3.48 model keys saved only after the provider accepts them, budget writes); 2026-10-29 (M4-10: 3.49 an admin invite is a row, and the row decides who gets in); 2026-10-29 (M5-1: 3.50 eval cases read through their loader, Python types generated); 2026-10-29 (M5-2: 3.51 /eval/\* takes only a platform-signed eval JWT on a staging connection, eval chats off the dashboard); 2026-10-30 (M5-3: 3.52 the eval judge is pinned and routed, transcripts built by the backend); 2026-10-30 (M5-4: 3.53 a version goes live only through its gate, a failed safety case blocks it; 3.47 publish from Ready); 2026-10-31 (M5-4 review: 3.53 min k, gate move in ChatbotConfigsRepo with System audit rows, clock_timestamp; 3.45 System actor); 2026-10-31 (M5-5: 3.54 platform cases only from code, nightly suite alerts from the backend; 3.55 production health from live rollups, one chatbot-wide issue; M5-6: 3.56 doc gaps stripped, clustered per chatbot, one Quality item per group)
Maintainer: hatiprithwish
