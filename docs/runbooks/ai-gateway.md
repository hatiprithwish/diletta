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

## Create a gateway and its token

Do this once per environment (`staging`, then `production`).

1. Cloudflare dashboard → **AI** → **AI Gateway** → **Create gateway**. Name it `diletta-staging` (or `diletta-production`). The name must match `AI_GATEWAY_NAME` for that env.
2. In the gateway's **Settings**, turn on **Authenticated Gateway**, and create an authentication token there. Copy the token once; Cloudflare doesn't show it again.
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

## Rotate the token

1. Create a new token in the gateway's settings (the old one keeps working until deleted).
2. `wrangler secrets-store secret update <STORE_ID> --secret-id <ID> --value …` for `diletta-aig-token-<env>`, update the password manager, and redeploy.
3. Delete the old token in the gateway.

## When a company's key fails

A provider rejecting a company key (or no active key for the routed provider) marks the key Invalid, shows "Temporarily unavailable" in the widget and opens one System / Model error issue for the company (Quality page). The fix is on the company's side: an admin replaces the key in Settings › Model keys. No platform action is needed.

## Prices

AI Gateway returns no cost per call, so `model_calls.cost_usd` comes from `MODEL_PRICES`. A model missing from the table is refused ("Temporarily unavailable"). When a provider changes a price or a company needs a new model, update the table with the source and date in the same PR.
