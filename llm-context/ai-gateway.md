# Cloudflare AI Gateway Documentation Links

Index: [ai-gateway/llms.txt](https://developers.cloudflare.com/ai-gateway/llms.txt)

- [Getting started](https://developers.cloudflare.com/ai-gateway/get-started/)
- [BYOK (Store Keys)](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Unified API (OpenAI compatible)](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)
- [Provider native endpoints](https://developers.cloudflare.com/ai-gateway/usage/providers/)
- [Anthropic](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
- [OpenAI](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
- [Workers binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- [Vercel AI SDK](https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/)
- [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)
- [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Legacy logs](https://developers.cloudflare.com/ai-gateway/observability/logging/legacy-logs/)
- [Costs](https://developers.cloudflare.com/ai-gateway/observability/costs/)
- [Custom costs](https://developers.cloudflare.com/ai-gateway/configuration/custom-costs/)
- [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [Rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)
- [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)

The Universal Endpoint is deprecated; don't build on it.

## How Diletta uses it

- Every chat model call goes through the model router (M2-3) and AI Gateway on the company's own provider key. Workers AI embeddings are the only platform-paid calls.
- Headers: `cf-aig-authorization: Bearer <token>` (authenticated gateway), `cf-aig-metadata: JSON.stringify({...})` (max 5 entries, string/number/boolean), `cf-aig-collect-log: false` (per-request log opt-out), `cf-aig-byok-alias: <alias>` (stored-key pick).
- Stored BYOK keys need an authenticated gateway and live in Secrets Store. `cf-aig-byok-alias` works only on provider-native passthrough; the Unified endpoints check the `default` alias only.
- M2-3 decision: provider-native endpoints (`/anthropic/v1`, `/openai`, `/google-ai-studio/v1beta`) through `@ai-sdk/anthropic|openai|google` with `baseURL` on the gateway. The router sends the decrypted company key itself in the provider's auth header; no BYOK, no Unified endpoint, no `ai-gateway-provider`. Same baseline ("company key via AI Gateway"), so no ADR.
- Metadata (`cf-aig-metadata`): `companyId`, `chatbotId`, `conversationId` or `evalRunId`, `turnId`, `taskType` — exactly the 5-entry cap. Tier and cost live in `model_calls`.
- No cost comes back per call: `model_calls.cost_usd` is computed from `MODEL_PRICES` (`packages/schemas/src/modelRouter/`). The response header `cf-aig-log-id` goes to `model_calls.gateway_log_id`.
- A gateway error (bad token, gateway rate limit) has an `error` array; a provider's own error has an `error` object. Only the provider's rejected-key shape marks a company key Invalid (`AiGatewayProvider.isRejectedKeyError`). Setup and token: `docs/runbooks/ai-gateway.md`.
- Log retention depends on gateway creation date: gateways created from 2026-09-24 follow Workers Logs retention; older ones use Legacy Logs. M6-1 targets 7 days.
