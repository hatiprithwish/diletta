# Test host

The test host (`apps/test-host`, M3-3) plays the customer app for our own test company. It does what a real host like eRegister does:

- signs the companion JWT the widget sends
- signs its own API token, which the adapter forwards (`jwt_forward`)
- serves its JWKS
- offers a REST API over records

The M3 tests (the action engine against a real host) and the nightly platform suite (M5-5) run against it.

It only runs on staging. There is no production test host, and its connection is a staging connection.

## What it offers

| Route                                        | Who can call it                                       | What it does                                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/jwks.json`                 | anyone                                                | Returns the public ES256 key. The platform fetches it as `{iss}/.well-known/jwks.json`.                                                                                                                                                     |
| `POST /auth/tokens`                          | admin (`X-Test-Host-Admin: <TEST_HOST_ADMIN_SECRET>`) | Takes `{workspace, sub, name?, roles?, expiresInSeconds?}` and returns `{companionJwt, hostToken, expiresAt}`.                                                                                                                              |
| `GET /v1/records?status&limit`               | host token                                            | Lists records in id order.                                                                                                                                                                                                                  |
| `GET /v1/records/:id`                        | host token                                            | Reads one record. Also used as the readback.                                                                                                                                                                                                |
| `POST /v1/records`                           | host token                                            | Creates a record. The test host picks the id.                                                                                                                                                                                               |
| `PATCH /v1/records/:id`                      | host token                                            | Changes only the fields you send.                                                                                                                                                                                                           |
| `PUT /v1/records/:id`                        | host token                                            | Creates or replaces the record under this id. This is how a delete is undone.                                                                                                                                                               |
| `DELETE /v1/records/:id`                     | host token                                            | Deletes a record. Answers 204.                                                                                                                                                                                                              |
| `POST /v1/_reset`                            | host token                                            | Puts the token's workspace back to `TEST_HOST_SEED_RECORDS`. Stored keys and faults are cleared. This is what the connection's `reset_op` will call once the eval reset flow (M5-2) defines it; until then the seed leaves `reset_op` null. |
| `GET` / `PUT /control/workspaces/:ws/faults` | admin                                                 | Reads or replaces the workspace's fault queue.                                                                                                                                                                                              |

- **Workspaces.** The host token's `ws` claim picks the workspace. Each workspace is its own Durable Object, so records never leak between workspaces. A new workspace starts empty; call `/v1/_reset` to load the seed records.
- **Keys.** Every write honours `Idempotency-Key` for 24 hours. Repeating a key with the same request returns the first answer without running the write again. Repeating it with a different request returns 422.
- **Email.** The test host stores `email` lowercased. Writing `A@X.com` reads back `a@x.com`, which is the "host stores the value in another form" case.
- **Token errors.** Any problem with a token (missing, expired, wrong signature, wrong `aud` or `iss`) returns the same 401. The adapter treats it as `TokenRejected`.

## Faults

Faults are queued per workspace. Each fault is used once, on the first request that matches its `method` and `path` (an exact pathname, e.g. `/v1/records/rec_alpha`; leaving one out matches anything). The matching request uses the fault up even when it has nothing to act on.

**Always filter on `method`.** Otherwise the read-before GET takes the fault meant for the write.

| Fault                                                            | What happens                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{kind: "status", status, isApplied: false, retryAfterSeconds?}` | The test host answers `status` before running anything: a refusal, or a 429/503 to retry.                                                                                                                                                                                                                         |
| `{kind: "status", status, isApplied: true}`                      | The write runs (and its key is stored), then the answer is replaced with `status`. The write landed but the caller can't tell.                                                                                                                                                                                    |
| `{kind: "overwrite", fields}`                                    | The write runs and answers normally, then `fields` are written over the record, as if someone else edited it. The read-after then mismatches. Only after a create, update or put that ran and succeeded (2xx): a refused write, a replayed `Idempotency-Key` answer, a read, a delete or a reset changes nothing. |
| `{kind: "delay", ms}`                                            | The request runs, then the answer is held for `ms` (at most 30 s).                                                                                                                                                                                                                                                |

## In backend tests

- `apps/backend/vitest.config.mts` runs the test host bundle as an auxiliary worker behind the `TEST_HOST` service binding.
- The config builds the bundle every time it loads (`pnpm test`, `vitest`, an IDE run), so no run uses a missing or stale one. Watch mode doesn't rebuild when the test host's source changes; restart it.
- Each run gets a fresh key and admin secret (`apps/test-host/testBindings.ts`) under the fake issuer `https://test-host.diletta.test`.
- Go through `src/tests/helpers/testHost.ts` for everything:
  - workspaces: `newTestHostWorkspace`
  - tokens: `mintTestHostTokens`
  - faults: `setTestHostFaults`
  - reset: `resetTestHost`
  - an adapter on the test host: `testHostAdapter`
  - loaded tools: `testHostTool`
- Record calls go through the adapter, never through `fetch` (pattern rule 3.31).
- `src/tests/testHost.test.ts` shows each idempotency mode and the read-after outcomes.

The test host's own tests are `pnpm --filter test-host test`.

## Local dev

```bash
pnpm --filter test-host keygen   # once: writes apps/test-host/.dev.vars
pnpm --filter test-host dev      # http://localhost:8788
```

The local issuer is `http://localhost:8788`. Platform connections must be https, so the local test host can't sign a widget in. Use it to try out the API with curl.

## Staging setup (once)

1. **Secrets.** These go into the Worker, not GitHub:

   ```bash
   cd apps/test-host
   pnpm --silent keygen --signing-key  | pnpm exec wrangler secret put TEST_HOST_SIGNING_KEY --env staging
   pnpm --silent keygen --admin-secret | pnpm exec wrangler secret put TEST_HOST_ADMIN_SECRET --env staging
   ```

   Keep `--silent`. Without it, pnpm prints its `> test-host@ keygen` banner to stdout ahead of the value, and the stored secret is corrupt: every route then answers 503 (unreadable key) or every admin call 401 (secret with newlines).

   Keep the admin secret in the team vault. It's needed to mint tokens and queue faults.

2. **Deploy.** Merging to `staging` runs `deploy-test-host-staging.yml`. By hand, `pnpm --filter test-host deploy` deploys the staging env too; there is no other target. The URL is `Schemas.TEST_HOST_STAGING_ISSUER` (`https://diletta-test-host-staging.hatiprithwish.workers.dev`). If that ever changes, change it in both places: the constant and `wrangler.jsonc` `env.staging.vars`.

3. **Test company.** Create it through the operator API (`POST /operator/companies`). That's the only path that also creates the company's encryption key.

4. **Seed.**

   ```bash
   pnpm --filter test-host seed --company <companyPublicId>
   ```

   - It writes as the owner role to the database in `apps/backend/.env` (staging).
   - On the first run it creates the staging connection, Active: issuer = the test host, `base_url = {issuer}/v1/`, `jwt_forward`, origin `http://localhost:5174` allowed, `reset_op` null.
   - On a rerun it only sets `base_url` and adds the dev origin. An operator's status and other origins are kept. A connection with another environment, adapter, auth type or credential scope is refused, never rewritten: replace it with a new one.
   - It stores each tool in `TEST_HOST_TOOL_DEFINITIONS`, Active. While the connection is disabled it seeds no tools and says so.
   - It's safe to rerun. A tool only gets a new version when its definition changed, so configs pinned to an older version keep it.
   - It refuses while a Draft of a tool exists.
   - It prints the `{name, version}` pins for the config and anything the company still lacks: a default chatbot, a published config, a model key.

## Changing the tools

Edit `packages/schemas/src/testHost/TestHostTools.ts`. Its test checks every tool against the same rules a tool definition save uses. Then rerun the seed and pin the new versions in the config.

## Rotating the signing key

Put a new `TEST_HOST_SIGNING_KEY`, as in step 1. Tokens signed with the old key fail straight away. The platform refetches the JWKS when it sees an unknown `kid` (rate-limited, see `JwksProvider`), so new companion JWTs work within a minute.
