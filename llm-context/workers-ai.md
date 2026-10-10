# Workers AI Documentation Links

Index: [workers-ai/llms.txt](https://developers.cloudflare.com/workers-ai/llms.txt)

- [Bindings (env.AI)](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [bge-m3 model page](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
- [bge-reranker-base model page](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/)
- [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Markdown conversion (toMarkdown)](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
- [Markdown conversion: supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)
- [Markdown conversion: binding usage](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [Workers AI through AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/)
- [Limits](https://developers.cloudflare.com/workers-ai/platform/limits/)

## How Diletta uses it

- The only platform-paid model calls (architecture baseline). Bound as `AI` in every env. Three calls, each in one file (pattern rule 3.10):
  - `env.AI.run("@cf/baai/bge-m3", { text: string[] }, { gateway: { id: env.AI_GATEWAY_NAME, metadata } })` in `providers/knowledgeEmbed.ts`. Output `{ data: number[][], shape }`, 1024 dims (`halfvec(1024)`); no usage is returned, so each call's row is usage Estimated at one token per input character (+2 special tokens). `env.AI.aiGatewayLogId` holds the call's gateway log id. Batches of `KNOWLEDGE_EMBED_BATCH_SIZE`. Used for ingestion (`knowledge.embed`) and a search's query (`search.embed`); the task type goes in the gateway metadata.
  - `env.AI.run("@cf/baai/bge-reranker-base", { query, contexts: { text }[], top_k }, { gateway })` in `providers/knowledgeRerank.ts` (M2-6, `search.rerank`). Output `{ response: { id, score }[] }`, best first, `id` = the context's index. Input is capped at 512 tokens per (query, context) pair. The generated `Ai_Cf_Baai_Bge_Reranker_Base_Input` type (worker-configuration.d.ts) has lost its `query` field, though the model requires it: pass the input as a variable (no excess-property check), never with a cast. `score` is already a probability in [0, 1] (the model's sigmoid applied; checked with a live call 2026-10-10: 0.993 for a matching passage, ~0.0001 for unrelated ones), so it is used as is and an answer outside [0, 1] is refused. The live answer also carries `usage.prompt_tokens`, missing from the generated output type; we still count Estimated at one token per character of query + context (+3 per pair), an overcount. bge-m3 returns no usage.
  - `env.AI.toMarkdown({ name, blob })` in `providers/knowledgeExtract.ts`, for HTML, PDF and DOCX only (the file name's extension picks the converter). Result `{ format: "markdown", data }` or `{ format: "error", error }`. Image conversion runs models and is billed, so images are never sent. Markdown and plain text are read as UTF-8 without it.
- Price (2026-10-09): bge-m3 $0.012 per M input tokens; bge-reranker-base $0.00311 per M input tokens (its model page; the pricing table rounds it to $0.003) (`PLATFORM_MODEL_PRICES`). Rows are tier Embed, provider `workers_ai`, written by `KnowledgeModelCallsProvider`, and are left out of the company budget seed.
- AI bindings always run remotely, even in `wrangler dev` (needs `wrangler login`). Tests set `remoteBindings: false` in `vitest.config.mts` and mock the knowledge providers, so no test reaches Workers AI or opens a remote session.
