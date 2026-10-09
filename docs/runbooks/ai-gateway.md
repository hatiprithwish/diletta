# AI Gateway

Every chat model call goes through Cloudflare AI Gateway on the company's own provider key (`ModelRouterRepo`, M2-3). The router sends the decrypted company key itself in the provider's auth header, so the gateway stores no per-company keys (no BYOK). The gateway is authenticated: a request without the platform's gateway token (`cf-aig-authorization`) is refused, so nobody can use our gateway with their own key.

## What exists per environment

| Environment | Gateway name         | Token source                                                 | Token secret name              |
| ----------- | -------------------- | ------------------------------------------------------------ | ------------------------------ |
| Local       | `diletta-staging`    | `apps/backend/.dev.vars` → `AI_GATEWAY_TOKEN` (plain string) | value of the staging secret    |
| Staging     | `diletta-staging`    | Secrets Store binding `AI_GATEWAY_TOKEN` (`env.staging`)     | `diletta-aig-token-staging`    |
| Production  | `diletta-production` | Secrets Store binding `AI_GATEWAY_TOKEN` (`env.production`)  | `diletta-aig-token-production` |

- `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_NAME` are plain vars in `apps/backend/wrangler.jsonc`, per env. Local dev uses the staging gateway, as it uses the staging database.
- The Secrets Store is the account's `default_secrets_store` (id in `wrangler.jsonc`), shared with the master key under different names.
- Code reads the token only in `AiGatewayProvider` (`apps/backend/src/providers/aiGateway.ts`). It never logs it.
- One token per environment does two jobs, so it needs two permissions: **Account → AI Gateway → Run** (the `cf-aig-authorization` header on model calls) and **Account → AI Gateway → Read** (the usage backfill reads gateway logs through the Cloudflare API). Nothing else.

## Create a gateway and its token

Do this once per environment (`staging`, then `production`).

1. Cloudflare dashboard → **AI** → **AI Gateway** → **Create gateway**. Name it `diletta-staging` (or `diletta-production`). The name must match `AI_GATEWAY_NAME` for that env.
2. In the gateway's **Settings**, turn on **Authenticated Gateway**, and create an authentication token there with **AI Gateway → Run** and **AI Gateway → Read** on the account (no Workers AI permissions). Copy the token once; Cloudflare doesn't show it again. A token already created with Run only: edit it under **My Profile → API Tokens** and add **AI Gateway → Read**; the value doesn't change.
3. Leave **Cache** off: answers depend on the conversation, the company's knowledge and its tools, never on the prompt alone.
4. Store the token in the Secrets Store and the password manager (`diletta aig token (staging)` / `(production)`):

```bash
cd apps/backend
pnpm exec wrangler secrets-store store list --remote          # store id
umask 077 && pbpaste | tr -d '\n' > token.txt                 # paste the token, never echo it
pnpm exec wrangler secrets-store secret create <STORE_ID> \
  --name diletta-aig-token-staging --scopes workers --remote --value "$(cat token.txt)"
# save token.txt to the password manager, then:
rm token.txt
```

5. Local: set `AI_GATEWAY_TOKEN` in `apps/backend/.dev.vars` to the staging token. Never put the production token on a dev machine.
6. Deploy (CI). The deploy token needs **Secrets Store → Edit**, as for the master key (`master-key.md`).

Gateways created from 2026-09-24 keep logs under Workers Logs retention; M6-1 sets the 7-day target.

## Check it works

- A company with an active model key for the routed provider and a published config whose routing lists models in `MODEL_PRICES` (`packages/schemas/src/modelRouter/ModelRouterCommon.ts`).
- A call shows in the gateway's **Logs** with `cf-aig-metadata` entries `companyId`, `chatbotId`, `conversationId` (or `evalRunId`), `turnId`, `taskType`, and a `model_calls` row whose `gateway_log_id` is that log's id.
- Wrong or missing token: every call fails with the gateway's 401 (`error` is an array). The router records `http_401` in `model_calls.error_code` and leaves every company key alone: only a provider's own rejection marks a key Invalid.

## Usage backfill

A call that reached the provider but ended without usage (stream cut or cancelled, connection lost) was still billed, so its `model_calls` row is written **Pending** (`usage_status = 2`) instead of a silent $0. The per-minute Cron (`ModelCallUsageBackfillCron` → `ModelCallsRepo.backfillPendingUsage`) reads each Pending row's gateway log by `gateway_log_id` once the row is a minute old:

- Log with token counts → **Backfilled** (3). `tokens_in` has no cache split, so every input token is priced at the dearer of the input and cache-write prices (an overcount, never an undercount). Lookups run 10 at a time.
- No log or no counts yet → stays Pending. After 1 hour → **Unknown** (4) with an error log; cost stays 0 and the budget must not read it as free.
- Lookup fails (API down, token without Read) → stays Pending and retries each minute until the hour is up.

Many Unknown rows usually mean logging is off on the gateway (Collect Logs must stay on) or the token lacks **AI Gateway → Read**.

## Rotate the token

1. Create a new token in the gateway's settings (the old one keeps working until deleted).
2. `wrangler secrets-store secret update <STORE_ID> --secret-id <ID> --value …` for `diletta-aig-token-<env>`, update the password manager, and redeploy.
3. Delete the old token in the gateway.

## When a company's key fails

Only the provider's own rejected-key answer counts: Anthropic 401 `authentication_error`, OpenAI 401, Google 400 `API_KEY_INVALID` or 401 `UNAUTHENTICATED`. Then the key is marked Invalid (only if it still holds the value the call used: a key the admin replaced or revoked meanwhile is left alone), the widget shows "Temporarily unavailable", and the company's one open System / Model error issue (Quality page) gets a line for that provider. A 403 (Anthropic `permission_error`, Google `PERMISSION_DENIED`) means the key is fine but can't use that model, or the API isn't enabled: the call fails, the key stays Active, no issue opens. The fix is on the company's side: an admin replaces the key in Settings › Model keys, or fixes the routing. No platform action is needed.

## Prices

AI Gateway returns no cost per call, so `model_calls.cost_usd` comes from `MODEL_PRICES`. A model missing from the table is refused ("Temporarily unavailable"). When a provider changes a price or a company needs a new model, update the table with the source and date in the same PR.
