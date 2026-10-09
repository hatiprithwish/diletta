# Workers AI Documentation Links

Index: [workers-ai/llms.txt](https://developers.cloudflare.com/workers-ai/llms.txt)

- [Bindings (env.AI)](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [bge-m3 model page](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
- [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Markdown conversion (toMarkdown)](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
- [Markdown conversion: supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)
- [Markdown conversion: binding usage](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [Workers AI through AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/)
- [Limits](https://developers.cloudflare.com/workers-ai/platform/limits/)

## How Diletta uses it

- The only platform-paid model calls (architecture baseline). Bound as `AI` in every env. Two calls, each in one file (pattern rule 3.10):
  - `env.AI.run("@cf/baai/bge-m3", { text: string[] }, { gateway: { id: env.AI_GATEWAY_NAME, metadata } })` in `providers/knowledgeEmbed.ts`. Output `{ data: number[][], shape }`, 1024 dims (`halfvec(1024)`); no usage is returned, so each call's row is usage Estimated at one token per input character (+2 special tokens). `env.AI.aiGatewayLogId` holds the call's gateway log id. Batches of `KNOWLEDGE_EMBED_BATCH_SIZE`.
  - `env.AI.toMarkdown({ name, blob })` in `providers/knowledgeExtract.ts`, for HTML, PDF and DOCX only (the file name's extension picks the converter). Result `{ format: "markdown", data }` or `{ format: "error", error }`. Image conversion runs models and is billed, so images are never sent. Markdown and plain text are read as UTF-8 without it.
- Price (2026-10-09): bge-m3 $0.012 per M input tokens (`PLATFORM_MODEL_PRICES`). Embed rows are tier Embed, provider `workers_ai`, and are left out of the company budget seed.
- AI bindings always run remotely, even in `wrangler dev` (needs `wrangler login`). Tests set `remoteBindings: false` in `vitest.config.mts` and mock the knowledge providers, so no test reaches Workers AI or opens a remote session.
