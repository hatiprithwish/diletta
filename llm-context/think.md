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
- Tools (M2-6): `getTools()` runs at every turn start and returns only `search_help_docs`; `beforeTurn`'s `activeTools` turns it on only for a bot with knowledge sources (`[]` otherwise, so the request carries no tools). Think wraps each tool's `execute` with its action-decision layer, which allows a plain server tool by default (`authorizeTurn` returns true). Tool calls and their outputs stream to the widget as message parts and are stored in the transcript inside the assistant message, so the tool's output carries citations only; the excerpts live in the running turn's memory by tool call id (`execute`'s and `toModelOutput`'s `toolCallId`). Think rebuilds history with `convertToModelMessages(messages, { tools })`, so `toModelOutput` also renders earlier turns' searches (titles only: their excerpts are gone). Before that, `truncateOlderMessages` (keepRecent 4, 500 chars per tool output) trims older outputs in a copy, which can leave a string marker inside the results array: the stored output is Zod-parsed, and one that no longer parses reads as "no longer shown", never as a failure.
- `onChatResponse` carries only the assistant message, and nothing runs for a turn cut by an eviction, so the read model isn't written from the hooks' arguments: after each turn and in `onStart` (every wake) the DO syncs `this.messages` past its stored position (`TranscriptProvider`). The Think session stays the source of truth.
- A stream error's `message` goes to the widget verbatim (`toUIMessageStream({ onError: streamErrorToString })`), bypassing `onChatError`; the router's middleware therefore makes every model failure a `ModelUnavailableError`. **Known limitation (0.19):** an error Think itself throws while iterating the stream (e.g. a DO storage error persisting a chunk, around `think.js:7641`) also goes out as its raw message. It's internal text, never provider text or a secret, and fixing it would mean rewrapping Think's private stream loop (which ADR 0001 avoids); re-check on every Think upgrade.
- After a hibernation wake Think's message cache is empty until the DO initializes, and a socket frame's own dispatch initializes it only after `webSocketMessage` runs: `ConversationDO.webSocketMessage` calls `__unsafe_ensureInitialized()` first. `onStart` runs under `blockConcurrencyWhile`, so no database work there (the read-model catch-up goes to `waitUntil`).
- The vitest pool can't evict a DO with work in flight or one that has run a turn (Think keeps it referenced), so eviction-dependent behaviour is tested by reproducing the state an eviction leaves behind.
- `configure()` / `getConfig()` (private DO SQLite) hold the runtime state (`ZConversationRuntimeState`: session, last activity, outcome flag, auto-close schedule). Never the host bearer token: keep it in a plain class field (see `durable-objects.md`).
- Actions (M3-4): write tools are `action({ kind: "durable-pause" })` from `getActions()`. Think runs the action's `approval` hook before it parks (the hook proposes: read-before, diff, change request) and its `execute` only after `approveExecution` (or at once when the hook returns false), so a refused or no-op call settles in the hook and `execute` returns that outcome. The pause is a row in Think's own SQLite (`pendingApprovals()`; the `executionId`, prefix `actpause_`, is minted after the hook, so the DO reads it back by tool call id once the turn ends). `approveExecution` / `rejectExecution` claim the row, replace the paused tool output and auto-continue the chat with a turn whose request id is Think's own (`trigger: "auto-continuation"`, `continuation: true` on its frames): `getModel()` is synchronous, so the DO prepares that continuation (config, tools, model, budget) before resolving the pause, and treats the first turn that ends while it is active as the continuation. Think compiles `getActions()` again when resolving, so an action must still be registered for an open change request's tool even if the running config no longer pins it. Think's tool-approval frames from a client stay refused; `actionPendingApprovalTtlMs` is set from `Constants.ACTION_PENDING_APPROVAL_TTL_MS`.
- The vitest pool can't evict a DO that ran a turn, nor one with database work in flight from inside it: the eviction test builds a parked turn's storage through Think's private `_parkDurablePauseAction` (0.19; re-check on every Think upgrade) in a DO that never ran a turn.
