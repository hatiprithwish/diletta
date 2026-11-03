# ADR 0005: A staging-only stub model for the load test

- Status: Accepted
- Date: 2026-11-02
- Task: M6-5 (load test)
- Changes: the locked decision "model calls only through the model router, on the company's own key via AI Gateway" (CLAUDE.md › Runtime): a company key that starts with `LOAD_STUB_MODEL_KEY_PREFIX`, in an env that sets `MODEL_BASE_URL_OVERRIDE`, talks to the stub model instead of AI Gateway.

## Context

The load test (M6-5) runs 50 concurrent chats of one company through the whole model path: the router, `BudgetDO`, the recording middleware. With a real provider, a run costs money, is held back by the provider's rate limits and adds the provider's latency and failures to numbers that are about our own platform. AI Gateway only forwards to real providers, so a stub can't sit behind it, and the gateway URL was hardcoded in `AiGatewayProvider`.

## Decision

1. `AiGatewayProvider` is still the only file that builds a provider SDK and decides where a call goes. It reads an optional `MODEL_BASE_URL_OVERRIDE` (a Worker var, `""` = off). When it is set **and** the company key starts with `LOAD_STUB_MODEL_KEY_PREFIX` (`diletta-load-stub-`), the model call and the model key check go to that base URL (the test host's `/model-stub/anthropic/v1`, `Schemas.TEST_HOST_MODEL_STUB_PATH`), with no AI Gateway token and no gateway headers. Any other key ignores the override.
2. The var is set in the staging env only. Production and local carry `""`; `worker-configuration.d.ts` types it from `wrangler.jsonc`, so a production value shows up as a type change in the same PR.
3. The stub (`apps/test-host`, `ModelStubRoutes`) speaks the Anthropic Messages API (streaming and not), answers one fixed reply with fixed usage, and serves only a stub key (a real key sent to it is a 401). It never stores or logs the key or the request.
4. The load test uses its own company (`LOAD_TEST_COMPANY_ID`, a staging company whose only model key is a stub key). The nightly suite and every other staging company keep calling the real model.

## Consequences

- The router, the budget (reserve, settle), the recording and the cost maths all run for real on stub calls; only the provider is absent. `model_calls` rows are real rows with the stub's usage, priced by the price table.
- No gateway log exists for a stub call, so a stub call has no `gateway_log_id`. Its usage comes in the stream, so it is never Pending and the usage backfill never reads it.
- The company's key (a sentinel, not a secret) is sent to the stub, our own Worker on the same account. A real key can never be sent there: the override needs the sentinel prefix.
- A stub key set on a production company does nothing but fail its calls at the real gateway (the provider rejects it), the same as any wrong key.
- The stub models only the happy path of a text reply: no tool use, no errors, no rate limits. The load test measures our platform under load, not the model.
