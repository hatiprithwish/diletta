# Neon Documentation Links

Index: [neon.com/docs/llms.txt](https://neon.com/docs/llms.txt) (guides: [neon.com/guides/llms.txt](https://neon.com/guides/llms.txt)). Append `.md` to any docs URL for markdown.

- [Branching](https://neon.com/docs/introduction/branching)
- [Manage branches](https://neon.com/docs/manage/branches)
- [Production and staging as branches](https://neon.com/branching/production-staging-workflows)
- [Connection pooling](https://neon.com/docs/connect/connection-pooling)
- [Choosing your connection method](https://neon.com/docs/connect/choose-connection)
- [Manage roles](https://neon.com/docs/manage/roles)
- [Manage database access](https://neon.com/docs/manage/database-access)
- [Use Neon with Cloudflare Hyperdrive](https://neon.com/docs/guides/cloudflare-hyperdrive)
- [Row-Level Security with Neon](https://neon.com/docs/guides/row-level-security)
- [PostgreSQL Row-Level Security tutorial](https://neon.com/postgresql/administration/row-level-security)
- [Adopt Postgres RLS for multi-tenant apps](https://neon.com/guides/rls-multi-tenant-apps)
- [Test RLS on Neon branches](https://neon.com/guides/test-rls-on-neon-branches)
- [Connect from Drizzle to Neon](https://neon.com/docs/guides/drizzle)
- [Schema migration with Drizzle](https://neon.com/docs/guides/drizzle-migrations)

## How Diletta uses it

- Two branches only: `staging` and `production`, each behind its own Hyperdrive config. Local dev and tests use `staging` via `apps/backend/.env`.
- Hyperdrive connects with the **direct** (non `-pooler`) connection string; Hyperdrive does the pooling. Neon's own pooler is PgBouncer in transaction mode and rejects `SET` / `RESET` on pooled connections.
- RLS context is `set_config('app.company_id', …, true)` inside `withTenant` only (see CLAUDE.md › Database).
- Roles made in the Console/CLI/API (incl. `diletta_owner`) are in `neon_superuser`, which has `BYPASSRLS` (it overrides even `FORCE ROW LEVEL SECURITY`), and it isn't a member of roles it creates, so `DROP OWNED BY` on them is denied. The worker connects as `diletta_app`, a least-privilege role created with SQL in the `*_rls_policies` migration (M1-3); the owner role stays for migrations and test fixtures. Roles are per branch: each branch sets `diletta_app`'s password once (`docs/runbooks/app-role.md`).
