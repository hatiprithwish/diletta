# App database role

The worker connects to Neon as `diletta_app`, a least-privilege role that row-level security applies to. The owner role (`diletta_owner`) has `BYPASSRLS` and is used only for migrations and test fixtures. If the worker connects as the owner, every RLS policy is silently skipped.

## What the migration does and doesn't do

`*_rls_policies` (M1-3) creates `diletta_app` as `NOLOGIN`, grants it `SELECT, INSERT, UPDATE, DELETE` on each table by name, and adds the policies. It can't set a password: that would put a credential in git. So each Neon branch needs the one-time setup below after the migration runs.

| Environment | Neon branch  | Hyperdrive config                                         | Password manager entry     |
| ----------- | ------------ | --------------------------------------------------------- | -------------------------- |
| Local       | `staging`    | none: `apps/backend/.env`                                 | `diletta_app (staging)`    |
| Staging     | `staging`    | `diletta-staging` (`fd1f535077964b0782517cca25e7c988`)    | `diletta_app (staging)`    |
| Production  | `production` | `diletta-production` (`eae07e9a1dfb486a83ef1f5fe7ee7b51`) | `diletta_app (production)` |

Roles belong to a Neon branch, so staging and production have separate passwords.

## Set up a branch

Order matters. If Hyperdrive switches to `diletta_app` before the role can log in, the worker can't connect. If the migration hasn't run, the role doesn't exist.

1. Run the migration on the branch. For production, put the production owner URL in `DATABASE_URL` in your shell; it takes precedence over `.env`:

   ```bash
   pnpm --filter backend db:migrate
   ```

2. Generate a password and allow login. Run this against the same branch as the owner (Neon SQL editor or `psql "$DATABASE_URL"`):

   ```bash
   umask 077 && openssl rand -hex 24 | tr -d '\n' > app.pw   # never echo it
   ```

   ```sql
   ALTER ROLE diletta_app WITH LOGIN PASSWORD '<contents of app.pw>';
   ```

   Save it to the password manager entry for that branch.

3. Point Hyperdrive at the role. Hyperdrive checks the login before it saves, so a wrong password fails here, not in production traffic:

   ```bash
   cd apps/backend
   pnpm exec wrangler hyperdrive update <HYPERDRIVE_ID> \
     --origin-user diletta_app --origin-password "$(cat app.pw)"
   rm app.pw
   ```

4. Check it: `pnpm exec wrangler hyperdrive get <HYPERDRIVE_ID>` shows `"user": "diletta_app"`.

5. Staging only: in `apps/backend/.env`, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` and `NEON_POOLER_URL` to `diletta_app` with that password. `DATABASE_URL` stays the owner. Then run `pnpm --filter backend test`. `src/tests/rls.test.ts` fails if the worker connection isn't `diletta_app`.

## Rotate the password

1. `ALTER ROLE diletta_app WITH PASSWORD '<new>';` on the branch.
2. Right away, run `wrangler hyperdrive update <HYPERDRIVE_ID> --origin-user diletta_app --origin-password '<new>'`. Connections Hyperdrive already has open keep working; new ones fail until this step is done.
3. Update the password manager entry, and for staging, everyone's `apps/backend/.env`.

## Roll back

`pnpm --filter backend db:rollback` runs the migration's `down.sql`, which drops `diletta_app`. Point Hyperdrive back at the owner **first** (`--origin-user diletta_owner --origin-password …`), or the worker loses its database.

## What can't run as diletta_app

- DDL: `CREATE`/`ALTER`/`DROP` of any kind, including new `activity_log` partitions (M1-9).
- The `drizzle` schema (migrations journal).
- `activity_log_*` partitions directly. The app reaches them only through `activity_log`, where the policies apply.
- A new table, until its migration grants it to `diletta_app` and adds its RLS policies.
