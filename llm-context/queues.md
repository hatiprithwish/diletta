# Cloudflare Queues Documentation Links

Index: [queues/llms.txt](https://developers.cloudflare.com/queues/llms.txt)

- [Getting started](https://developers.cloudflare.com/queues/get-started/)
- [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [Batching, retries and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Dead letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Local development](https://developers.cloudflare.com/queues/configuration/local-development/)
- [Limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Publish via a Worker](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-workers/)
- [Use Queues with Durable Objects](https://developers.cloudflare.com/queues/examples/use-queues-with-durable-objects/)
- [Wrangler commands](https://developers.cloudflare.com/queues/reference/wrangler-commands/)

## How Diletta uses it

- Critical events are written as `activity_log` + `event_outbox` in one `withTenant` transaction; the relay (`waitUntil` + Cron sweep, M1-6) publishes pending outbox rows to the Queue. Nothing sends a critical event to a Queue directly.
- Delivery is at-least-once: consumers dedupe on the outbox row's id as the idempotency key.
- If `queue()` throws, the whole batch is retried; ack/retry per message instead. Defaults: batch 10 (max 100), timeout 5s, `max_retries` 3. Without a DLQ, messages past the retry limit are deleted, so every consumer gets a DLQ.
- Limits: 128 KB per message, 100 messages / 256 KB per `sendBatch`, 15 min consumer wall time.
