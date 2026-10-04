# Cloudflare Durable Objects Documentation Links

Index: [durable-objects/llms.txt](https://developers.cloudflare.com/durable-objects/llms.txt)

- [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [In-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
- [Durable Object State (`ctx`)](https://developers.cloudflare.com/durable-objects/api/state/)
- [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Use WebSockets (Hibernation API)](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [WebSocket Hibernation server example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Invoke methods (stubs and RPC)](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)
- [Error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
- [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## How Diletta uses it

- Conversation DO (built on Think, see `think.md`) per conversation; `BudgetDO` per company (reserve before each model call, settle after).
- In-memory state is discarded on hibernation (idle ~10s with hibernatable WebSockets), eviction or a crash; the constructor runs again on the next event.
- The host bearer token lives only in a plain DO class field. Never in `ctx.storage`, SQLite, `serializeAttachment`, Agent state or logs. When it is gone, the DO sends `token_needed` and the widget fetches a new one silently (M3-8).
- DOs reach Neon only through a tenant Repo (`withTenant`), with a db client built per request.
