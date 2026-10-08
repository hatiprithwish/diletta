# Vercel AI SDK Documentation Links

Index: [ai-sdk.dev/llms.txt](https://ai-sdk.dev/llms.txt)

Installed (apps/backend, pinned, 7-day release age): `ai` 7.0.126, `@ai-sdk/anthropic` 4.0.71, `@ai-sdk/openai` 4.0.83, `@ai-sdk/google` 4.0.87, all on `@ai-sdk/provider` 4.0.21 (`LanguageModelV4`). `ai` ^7 is what `@cloudflare/think` peers on.

- [Language model middleware (`wrapLanguageModel`)](https://ai-sdk.dev/docs/ai-sdk-core/middleware)
- [Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
- [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- [Google Generative AI provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)
- [Error handling (`APICallError`)](https://ai-sdk.dev/docs/ai-sdk-core/error-handling)
- [Testing (`ai/test` mock models)](https://ai-sdk.dev/docs/ai-sdk-core/testing)

## How Diletta uses it

- Only `providers/aiGateway.ts` imports `@ai-sdk/<provider>` (pattern rule 3.10). `createAnthropic` / `createOpenAI` / `createGoogle` get `baseURL` on AI Gateway, the company key as `apiKey`, and the gateway headers.
- `ModelRouterRepo` wraps the model with `LanguageModelMiddleware` (`wrapGenerate` / `wrapStream`) to write `model_calls`. v4 usage is nested: `inputTokens.{total, noCache, cacheRead, cacheWrite}`, `outputTokens.{total, text, reasoning}`; a stream reports it in its `finish` part. Response headers are on `result.response.headers`.
- Errors from the provider are `APICallError` (`statusCode`, `responseBody`). Tests mock `fetch` for gateway URLs rather than injecting a fetch into the provider.
