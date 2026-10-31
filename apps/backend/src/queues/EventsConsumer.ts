import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import DocGapsRepo from "@/repositories/DocGapsRepo";

// DEV_NOTE: EVENTS_QUEUE consumer. Each message is one outbox row (Schemas.EventOutboxMessage). Messages are acked
// one by one, so one bad message never retries the batch. A body that doesn't parse can never succeed, so it is
// logged and acked rather than retried into the DLQ. Delivery is at-least-once: a handler for an eventType dedupes on
// its own table and goes through a Repo. doc_gap.candidate (M5-6) → DocGapsRepo; a failure a later try can fix retries
// the message, up to the queue's max_retries and then its DLQ. Every other event is logged and acked.
export default async function consumeEvents(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
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

    if (parsed.data.eventType === Schemas.DOC_GAP_CANDIDATE_EVENT_TYPE) {
      await handleDocGapCandidate(message, parsed.data, env, ctx);
      continue;
    }
    message.ack();
  }
}

async function handleDocGapCandidate(
  message: Message<unknown>,
  event: Schemas.EventOutboxMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  try {
    const processed = await new DocGapsRepo(env, ctx).processCandidate(event);
    if (processed.isSuccess) {
      message.ack();
      return;
    }
    AppLogger.error({
      category: Schemas.LogCategory.Queue,
      action: Schemas.LogAction.ProcessDocGapCandidate,
      message: processed.message ?? "Doc gap candidate not processed; retrying",
      metadata: { outboxId: event.outboxId, attempts: message.attempts },
    });
  } catch (error) {
    AppLogger.error({
      category: Schemas.LogCategory.Queue,
      action: Schemas.LogAction.ProcessDocGapCandidate,
      message: "Doc gap candidate failed; retrying",
      error,
      metadata: { outboxId: event.outboxId, attempts: message.attempts },
    });
  }
  message.retry();
}
