# Cloudflare Think (Agents SDK) Documentation Links

Index: [agents/llms.txt](https://developers.cloudflare.com/agents/llms.txt) (covers Think)

Not installed yet. Latest on npm (2026-10-04): `@cloudflare/think` 0.20.0, `agents` 0.26.0; Think peers `agents >=0.25.0 <1.0.0`, `ai ^7`, `zod ^4`. M2-2 adds and pins them (ask before installing).

## Think

- [Think overview](https://developers.cloudflare.com/agents/harnesses/think/)
- [Getting started](https://developers.cloudflare.com/agents/harnesses/think/getting-started/)
- [Configuration (`getModel`, `getSystemPrompt`, `getTools`, sessions)](https://developers.cloudflare.com/agents/harnesses/think/configuration/)
- [Tools](https://developers.cloudflare.com/agents/harnesses/think/tools/)
- [Client tools and approvals](https://developers.cloudflare.com/agents/harnesses/think/client-tools/)
- [Lifecycle hooks](https://developers.cloudflare.com/agents/harnesses/think/lifecycle-hooks/)
- [Sub-agent RPC and programmatic turns](https://developers.cloudflare.com/agents/harnesses/think/sub-agents/)
- [Durable recovery](https://developers.cloudflare.com/agents/harnesses/think/recovery/)

## Agents SDK runtime

- [Agent class internals](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/)
- [Store and sync state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/)
- [Sessions](https://developers.cloudflare.com/agents/runtime/lifecycle/sessions/)
- [WebSockets](https://developers.cloudflare.com/agents/runtime/communication/websockets/)
- [Durable execution with fibers](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)
- [Using AI models](https://developers.cloudflare.com/agents/runtime/operations/using-ai-models/)
- [Testing your agents](https://developers.cloudflare.com/agents/getting-started/testing-your-agent/)

## How Diletta uses it

- The Conversation DO extends Think (M2-2). `getModel()` returns `ModelRouterRepo.getModel(...)`'s `model` (an AI SDK v7 `LanguageModel`, already wrapped to write `model_calls`); it never builds a provider client itself. A `failure`, or a `ModelUnavailableError` thrown from the call, shows the widget "Temporarily unavailable". `ai@7` is pinned to satisfy Think's `ai ^7` peer.
- Agent state (`setState`, `this.sql`, message history) is persisted to SQLite and survives hibernation. Never put the host bearer token there; keep it in a plain class field (see `durable-objects.md`).
- `turn_id` (ULID) is minted per turn in the DO and written to messages, tool calls and model calls.
- Approval-paused turns park instead of failing across eviction; the action engine's durable pause (M3-4) builds on that.
