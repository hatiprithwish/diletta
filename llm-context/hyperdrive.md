# Cloudflare Hyperdrive Documentation Links

Index: [hyperdrive/llms.txt](https://developers.cloudflare.com/hyperdrive/llms.txt)

- [Getting started](https://developers.cloudflare.com/hyperdrive/get-started/)
- [How Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)
- [Connection pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)
- [Connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/)
- [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Neon](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)
- [node-postgres (pg)](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)
- [Drizzle ORM](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
- [Local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
- [Tune connection pooling](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/)
- [Supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
- [Wrangler commands](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/)
- [Limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)
- [Troubleshoot and debug](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/)

## How Diletta uses it

- Pooling is transaction mode: a connection goes back to the pool after each transaction and is `RESET`, so `SET` lasts one transaction at most. That is why tenant context is `set_config(…, true)` inside `withTenant` and never per session.
- Not supported: SQL-level `PREPARE` / `DISCARD` / `DEALLOCATE`, advisory locks, `LISTEN` / `NOTIFY`, other per-session state. node-postgres named prepared statements work.
- Query caching is off. It is a property of the Hyperdrive config, not `wrangler.jsonc`: create or update each config with `--caching-disabled` (`pnpm exec wrangler hyperdrive update <ID> --caching-disabled`). Default when on is `max_age` 60s; writes don't invalidate it.
- `dbClient.ts` builds a new client per request (recommended by the docs; no `end()` needed, also in DOs and Queue consumers). Never cache a client across requests.
- `pg` ≥ 8.16.3 and `nodejs_compat` are required. Local dev: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` overrides `localConnectionString`; local mode skips pooling and caching.
