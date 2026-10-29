# Model keys

Settings › Model keys (M4-10, `/settings/model-keys`) is where a company admin adds and rotates the provider keys every model call uses (`company_secrets` rows of type Model key). Company admins manage their own company; operators get 403 (the dashboard is company-level). Without an Active key for each provider a bot's routing uses, that bot can't be published (Settings › Bots, `ModelKeyMissing`) and its calls fail.

## What the page shows

One row per key: provider, the last four characters (none for a key under 12 characters), status, and when the provider last accepted it. The value itself never leaves the backend: it's encrypted under the company key on save and only the model router decrypts it.

- **Active**: in use.
- **Invalid**: the provider rejected it during a call (the router marks it, see `docs/runbooks/ai-gateway.md`), so that provider's calls fail until it's rotated.
- **Revoked**: no longer used.

## Add key and Rotate

Add first refuses a provider that already has an Active key (409, no provider call). Then both check the pasted key with the provider before anything is saved: a `GET …/models` through AI Gateway (`AiGatewayProvider.checkModelKey`, 10 s timeout, `cf-aig-skip-cache` so it is never answered from cache). A restricted OpenAI key that may not list models (401 "Missing scopes") authenticated fine, so it is accepted. Listing models is free, so the check is never billed, and it doesn't count against the budget. The check uses the router's own rule for a bad key, so a key the page accepts is one the router won't mark Invalid on its first call.

| Answer                                                                                                                           | Status                     | What the admin sees                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Provider accepts the key                                                                                                         | 201 / 200                  | Saved, Active, Last checked = now                                   |
| Anthropic 401 `authentication_error`, OpenAI 401 (not a missing-scope one), Google 400 `API_KEY_INVALID` / 401 `UNAUTHENTICATED` | 400 `KeyRejected`          | "The provider rejected this key." Nothing saved                     |
| Anything else: a 403 (key fine, API or model not enabled), a gateway error, a timeout                                            | 502 `CheckUnavailable`     | "The provider couldn't be reached to check this key." Nothing saved |
| Add for a provider that already has an Active key                                                                                | 409 `ProviderHasActiveKey` | Rotate that key instead                                             |

- **Add key** picks a provider and saves a new Active key (one Active key per provider: `UNQ_company_secrets_company_id_provider_active`).
- **Rotate** replaces a key's value in place (same row, so nothing pointing at it changes), any status: an Invalid key comes back Active. The row is locked, so two rotations run one after the other. `rotated_at` is set.

Each save records an audit row (Added model key / Rotated model key, on the provider), shown in Security › Audit log. A refusal records nothing.

## When the check keeps failing (502)

- Look for `CheckModelKey` errors (`LogCategory.ModelRouter`): the message carries the HTTP status, never the key.
- "AI Gateway is not configured": `AI_GATEWAY_TOKEN`, `AI_GATEWAY_ACCOUNT_ID` or `AI_GATEWAY_NAME` is missing in that environment (`docs/runbooks/ai-gateway.md`).
- A gateway 401 (body `error` is an array): the platform's gateway token is wrong, not the company's key. Rotate the gateway token.
- A provider 403: the key is valid, but the provider account has no access to the models list (Google: the Generative Language API isn't enabled for the key's project). The admin fixes it at the provider.

## Not built yet

- The test judge card (which judge model test runs use, and whether the keys reach it) comes with test runs (M5-2).
- Revoke: no button yet. An admin rotates a key instead; an operator can set a row Revoked on the owner connection if a key must stop being used at once.
