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
- Repo importing directly from Drizzle
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

**Fix:** Route files should only import Repo. Repo should only import DAL. DAL should only import Drizzle/DB.

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
File: apps/backend/src/routes/NotesRoutes.ts (golden file)
- ✅ import { NotesRepo } from "../repositories"
- ✅ import { LogCategory } from "@app/schemas"
- ❌ import { NotesRepo } from "../../routes/../repositories" (verbose relative)
```

**Fix:** Relative imports for sibling layers, `@app/schemas` for cross-app schemas.

---

### 1.6 Database Schema Pattern [CRITICAL]

**Rule:** After ANY schema change, run `pnpm db:generate` and `pnpm db:migrate` immediately.

**Violations:**

- Schema change in `apps/backend/src/db/tables.ts` without `pnpm db:generate` command
- Schema change without migration file committed alongside
- Migration file missing or in separate commit

**Detection:**

```
PR contains changes to: apps/backend/src/db/tables.ts
But does NOT contain:
- Generated migration file
- Evidence of db:generate command
```

**Fix:** After schema changes, commit generated migration files in the same commit.

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
- ❌ apps/backend/src/repositories/NotesDAL.ts
- ✅ apps/backend/src/data-access-layer/NotesDAL.ts

- ❌ apps/web/src/routes/_authenticated/notes/data.ts
- ✅ apps/web/src/routes/_authenticated/notes/-data.ts

- ❌ apps/web/src/routes/_authenticated/notes/NoteCard.tsx
- ✅ apps/web/src/routes/_authenticated/notes/-NoteCard.tsx
```

**Fix:** Move file to correct folder per CLAUDE.md structure.

---

### 1.8 Naming Conventions [WARNING]

**Rule:** Follow naming conventions per layer and language.

**Violations:**

- Class names not PascalCase (`notesRepo` instead of `NotesRepo`)
- Function names not camelCase (`GetNotes` instead of `getNotes`)
- Constants not SCREAMING_SNAKE_CASE (if not PascalCase)
- DAL method names inconsistent with pattern
- Repo method names inconsistent with pattern

**Detection:**

```
Database columns:
- ❌ userName (should be snake_case in DB)
- ✅ user_name (in DB), userData (in code)

TypeScript classes/functions:
- ❌ class notesRepository
- ✅ class NotesRepository

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
- ❌ async getNotes() { return await this.db.select() }
- ✅ async getNotes() {
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

### 2.2 Design System Colors [WARNING]

**Rule:** Use project color scale, not hardcoded hex values.

**Violations:**

- Direct hex colors in classes or inline styles
- Arbitrary color values `[#FF5733]`
- Brand colors hardcoded instead of using variables

**Detection Pattern:**

```regex
\[\#[0-9A-Fa-f]{6}\]
style=.*color:\s*['#]
```

**Examples:**

```
- ❌ className="bg-[#1a1a1a]"
- ✅ className="bg-slate-900"

- ❌ style={{ color: "#FF5733" }}
- ✅ className="text-red-500"
```

**Fix:** Reference Tailwind color scale or project design tokens.

---

## 3. ADDING NEW RULES

To add a new custom rule:

1. Add a new subsection under "CUSTOM RULES & PROJECT-SPECIFIC PATTERNS"
2. Include these sections:
   - **Rule:** Clear one-liner (what is forbidden/required)
   - **Violations:** Specific bad patterns
   - **Detection Pattern:** Regex or exact string to search for (optional)
   - **Examples:** ❌ Bad code, ✅ Good code
   - **Fix:** How to correct it
   - Add severity tag: `[CRITICAL]`, `[WARNING]`, or `[INFO]`

**Example format:**

```markdown
### 2.X Your New Rule [SEVERITY]

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

## 4. SEVERITY DEFINITIONS

| Level        | Meaning                                                     | Action                  | Symbol |
| ------------ | ----------------------------------------------------------- | ----------------------- | ------ |
| **CRITICAL** | Breaks architecture, type safety, or production safety      | Must fix before merge   | 🔴     |
| **WARNING**  | Inconsistent with standards but doesn't break functionality | Should fix before merge | 🟡     |
| **INFO**     | Best practice suggestion or minor improvement               | Nice to have            | 🔵     |

---

## 5. WORKFLOW INTEGRATION

The Pattern Enforcer workflow (`pattern-enforcer.yml`) automatically:

1. Reads this file on every PR
2. Checks only the PR diff (token-efficient, not entire codebase)
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

- ✅ Only diffs are analyzed (not entire files)
- ✅ Rules file is read once per PR
- ✅ Pattern matching is efficient
- ✅ No full codebase scans required

---

## Last Updated

Created: 2025
Maintainer: hatiprithwish
