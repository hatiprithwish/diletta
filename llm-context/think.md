# Cloudflare Think (Agents SDK) Documentation Links

Index: [agents/llms.txt](https://developers.cloudflare.com/agents/llms.txt) (covers Think)

Installed in `apps/backend` (M2-2), pinned: `@cloudflare/think` 0.19.0, `agents` 0.24.0 (Think peers `agents >=0.24.0 <1.0.0`, `ai ^6 || ^7`, `zod ^4`). Newer releases exist; upgrades wait out the 7-day release age and re-check the internals listed below.

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

- Pinned: `@cloudflare/think` 0.19.0 + `agents` 0.24.0 (newest past the repo's 7-day release age). The docs above track the latest release; check `node_modules` when they disagree.
- `ConversationDO` (M2-2, `apps/backend/src/durable-objects/`) extends Think, one per conversation, named by `conversations.public_id`. It is reached only through `GET /widget/ws`, after the worker has authenticated the JWT and started or resumed the conversation (ADR 0001). Never `routeAgentRequest`.
- Think internals that shaped the design (0.19):
  - On connect it sends the transcript before any subclass hook runs.
  - It handles `cf_agent_*` chat frames before `onMessage`, and its chat broadcasts go to all sockets.
  - It upserts client-sent messages by id, and a client `clear` frame wipes history.
  - Hence: auth before the upgrade, and a `webSocketMessage` override that allowlists and rebuilds frames before handing them to `this.lifecycle.webSocketMessage`. Agents installs its own handler only when the class has none.
- `getModel()` runs before `beforeTurn` and is synchronous, so the turn's config and routed model (`ModelRouterRepo.getModel`) are prepared while admitting the chat frame. `getModel` and `beforeTurn` return them; one turn runs at a time.
- Defaults turned off: workspace tools incl. bash (`workspaceBash`), MCP tools, reasoning chunks, the identity frame, durable recovery (`chatRecovery: { maxAttempts: 0 }`, since a turn's routed model lives in memory). `onChatError`'s return value is broadcast as the error text, so it stays generic.
- `onChatResponse` carries only the assistant message; the user message is read from `this.messages`. Both go to the `messages` read model with the turn's ULID. The Think session stays the source of truth.
- `configure()` / `getConfig()` (private DO SQLite) hold the runtime state (`ZConversationRuntimeState`: session, last activity, outcome flag, auto-close schedule). Never the host bearer token: keep it in a plain class field (see `durable-objects.md`).
- Approval-paused turns park instead of failing across eviction; the action engine's durable pause (M3-4) builds on that.
