import z from "zod";
import { ZActivityLogBase } from "../activityLog/ActivityLogCommon";

export enum EventOutboxStatusIntEnum {
  Pending = 1,
  Published = 2,
  Failed = 3,
}

export enum EventOutboxStatusLabelEnum {
  Pending = "Pending",
  Published = "Published",
  Failed = "Failed",
}

export const EVENT_OUTBOX_STATUS_LABEL_MAP: Record<
  EventOutboxStatusIntEnum,
  EventOutboxStatusLabelEnum
> = {
  [EventOutboxStatusIntEnum.Pending]: EventOutboxStatusLabelEnum.Pending,
  [EventOutboxStatusIntEnum.Published]: EventOutboxStatusLabelEnum.Published,
  [EventOutboxStatusIntEnum.Failed]: EventOutboxStatusLabelEnum.Failed,
};

// Critical Event Body — one activity_log row plus the event_outbox row that publishes it
// DEV_NOTE: dedupeKey is unique per company (UQ company_id, dedupe_key) while the outbox row lives, i.e. until the
// purge after publish. The writer derives it from the event, e.g. `change_request:<id>:verified`, so a retried
// step records the event once.
export const ZCriticalEventBase = ZActivityLogBase.extend({
  eventType: z.string().trim().min(1),
  dedupeKey: z.string().trim().min(1),
});
export type CriticalEventBase = z.infer<typeof ZCriticalEventBase>;

// Whole Event Outbox Body — DB shape (enums stored as integers)
// DEV_NOTE: Append-only queue table, so no publicId or updatedAt. Every id is internal; outbox rows never reach a client.
export const ZEventOutbox = z.object({
  id: z.string(),
  companyId: z.string(),
  activityLogId: z.string(),
  eventType: z.string(),
  dedupeKey: z.string(),
  status: z.enum(EventOutboxStatusIntEnum),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  publishedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type EventOutbox = z.infer<typeof ZEventOutbox>;

// Queue message body — what the relay sends to EVENTS_QUEUE for one outbox row
// DEV_NOTE: Delivery is at-least-once (a relay can die between send and commit), so consumers dedupe on outboxId.
// Ids are internal: the queue never leaves the platform worker. Consumers read the activity_log row for details.
export const ZEventOutboxMessage = z.object({
  outboxId: z.string().min(1),
  companyId: z.string().min(1),
  activityLogId: z.string().min(1),
  eventType: z.string().min(1),
  dedupeKey: z.string().min(1),
});
export type EventOutboxMessage = z.infer<typeof ZEventOutboxMessage>;
