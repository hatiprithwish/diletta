import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: EVENTS_QUEUE consumer. Each message is one outbox row (Schemas.EventOutboxMessage). Messages are acked
// one by one, so one bad message never retries the batch. A body that doesn't parse can never succeed, so it is
// logged and acked rather than retried into the DLQ. Delivery is at-least-once: a handler added here for an
// eventType (doc gaps, rollups, notifications) dedupes on outboxId in its own table and goes through a Repo.
// Until then every event is logged and acked.
export default async function consumeEvents(batch: MessageBatch<unknown>): Promise<void> {
  for (const message of batch.messages) {
    const parsed = Schemas.ZEventOutboxMessage.safeParse(message.body);
    if (!parsed.success) {
      AppLogger.error({
        category: Schemas.LogCategory.Queue,
        action: Schemas.LogAction.ConsumeEvent,
        message: "Invalid event message",
        metadata: { queue: batch.queue, messageId: message.id, issues: parsed.error.issues },
      });
      message.ack();
      continue;
    }

    AppLogger.info({
      category: Schemas.LogCategory.Queue,
      action: Schemas.LogAction.ConsumeEvent,
      message: "Event received",
      metadata: { ...parsed.data, attempts: message.attempts },
    });
    message.ack();
  }
}
