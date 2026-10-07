import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import EventOutboxDAL from "@/data-access-layer/EventOutboxDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

// DEV_NOTE: Outbox relay. Writers record a critical event with CriticalEventProvider inside their own withTenant
// (or recordCriticalEvent here, when the event is the only write); after the commit they relay its outboxId with
// relayEvents in waitUntil. The Cron sweep publishes whatever that relay missed (a killed isolate, a failed send),
// and purges published rows. Each publish locks its rows FOR UPDATE SKIP LOCKED, sends them, and marks them
// published in one transaction, so a row is handed to the Queue by one relay at a time. A relay that dies between
// the send and the commit leaves the row pending and it is sent again: delivery is at-least-once, and consumers
// dedupe on outboxId. The sweep and the purge span companies, so they run in withPlatform (pattern rule 3.15).
export default class EventOutboxRepo {
  private db: NodePgDatabase;
  private dal: EventOutboxDAL;
  private queue: Queue<Schemas.EventOutboxMessage>;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new EventOutboxDAL();
    this.queue = env.EVENTS_QUEUE;
  }

  async recordCriticalEvent(
    params: Schemas.CriticalEventBase & { companyId: string },
  ): Promise<Schemas.RecordCriticalEventResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await CriticalEventProvider.record(tx, params);
      if (!result.isSuccess) {
        throw new TenantRollbackError(result.message);
      }

      return result;
    });
  }

  // DEV_NOTE: After-commit relay for the rows a writer just recorded. Rows already published, or locked by the
  // sweep, are skipped.
  async relayEvents(params: {
    companyId: string;
    outboxIds: string[];
  }): Promise<Schemas.RelayEventsResponse> {
    if (params.outboxIds.length === 0) {
      return { isSuccess: true, message: "No events to relay", publishedCount: 0, failedCount: 0 };
    }

    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.publishPendingEvents(tx, {
        companyId: params.companyId,
        outboxIds: params.outboxIds,
        createdBefore: null,
        limit: params.outboxIds.length,
      });
    });
  }

  // DEV_NOTE: Cron sweep across companies: pending rows older than OUTBOX_SWEEP_MIN_AGE_MS, oldest first, one
  // transaction per batch. Stops at the first failed batch (the Queue is likely down) and resumes next minute.
  async sweepPendingEvents(): Promise<Schemas.RelayEventsResponse> {
    const createdBefore = new Date(Date.now() - Constants.OUTBOX_SWEEP_MIN_AGE_MS);
    let publishedCount = 0;
    let failedCount = 0;

    for (let batch = 0; batch < Constants.OUTBOX_SWEEP_MAX_BATCHES; batch++) {
      const result: Schemas.RelayEventsResponse = await withPlatform(this.db, async (tx) => {
        return await this.publishPendingEvents(tx, {
          companyId: null,
          outboxIds: null,
          createdBefore,
          limit: Constants.OUTBOX_BATCH_SIZE,
        });
      });
      const { publishedCount: published = 0, failedCount: failed = 0 } = result;
      publishedCount += published;
      failedCount += failed;

      if (!result.isSuccess) {
        return { isSuccess: false, message: result.message, publishedCount, failedCount };
      }
      if (published + failed < Constants.OUTBOX_BATCH_SIZE) break;
    }

    return {
      isSuccess: true,
      message: "Pending events swept successfully",
      publishedCount,
      failedCount,
    };
  }

  // DEV_NOTE: Published rows older than the retention window. Pending and Failed rows stay for the sweep and the
  // relay-failure runbook.
  async purgePublishedEvents(): Promise<Schemas.PurgePublishedEventsResponse> {
    const publishedBefore = new Date(
      Date.now() - Constants.OUTBOX_PUBLISHED_RETENTION_DAYS * DAY_MS,
    );

    return await withPlatform(this.db, async (tx) => {
      return await this.dal.deletePublishedEventOutboxes(tx, { publishedBefore });
    });
  }

  private async publishPendingEvents(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.LockPendingEventOutboxesDALRequest,
  ): Promise<Schemas.RelayEventsResponse> {
    const locked = await this.dal.lockPendingEventOutboxes(tx, params);
    if (!locked.isSuccess || !locked.eventOutboxes) {
      return { isSuccess: false, message: locked.message };
    }
    if (locked.eventOutboxes.length === 0) {
      return { isSuccess: true, message: "No pending events", publishedCount: 0, failedCount: 0 };
    }

    const outboxIds = locked.eventOutboxes.map((row) => row.id);
    try {
      await this.queue.sendBatch(
        locked.eventOutboxes.map((row) => ({
          body: {
            outboxId: row.id,
            companyId: row.companyId,
            activityLogId: row.activityLogId,
            eventType: row.eventType,
            dedupeKey: row.dedupeKey,
          },
        })),
      );
    } catch (error) {
      return await this.recordFailedAttempt(tx, {
        companyId: params.companyId,
        outboxIds,
        error,
      });
    }

    const published = await this.dal.markEventOutboxesPublished(tx, {
      companyId: params.companyId,
      outboxIds,
    });
    if (!published.isSuccess || !published.eventOutboxes) {
      return { isSuccess: false, message: published.message };
    }

    return {
      isSuccess: true,
      message: "Events published successfully",
      publishedCount: published.eventOutboxes.length,
      failedCount: 0,
    };
  }

  // DEV_NOTE: The rows stay pending for the next sweep until OUTBOX_MAX_ATTEMPTS, then move to Failed. A Failed row
  // is never retried automatically, so it alerts (error log → Sentry, M6-6).
  private async recordFailedAttempt(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string | null; outboxIds: string[]; error: unknown },
  ): Promise<Schemas.RelayEventsResponse> {
    const message = "Events could not be published";
    AppLogger.error({
      category: Schemas.LogCategory.Relay,
      action: Schemas.LogAction.RelayEvents,
      message,
      error: params.error,
      metadata: { companyId: params.companyId, outboxIds: params.outboxIds },
    });

    const lastError = (
      params.error instanceof Error ? params.error.message : String(params.error)
    ).slice(0, Constants.OUTBOX_LAST_ERROR_MAX_LENGTH);
    const attempted = await this.dal.markEventOutboxAttemptFailed(tx, {
      companyId: params.companyId,
      outboxIds: params.outboxIds,
      lastError,
      maxAttempts: Constants.OUTBOX_MAX_ATTEMPTS,
    });
    if (!attempted.isSuccess || !attempted.eventOutboxes) {
      return { isSuccess: false, message: attempted.message };
    }

    const failedRows = attempted.eventOutboxes.filter(
      (row) => row.status === Schemas.EventOutboxStatusIntEnum.Failed,
    );
    if (failedRows.length > 0) {
      AppLogger.error({
        category: Schemas.LogCategory.Relay,
        action: Schemas.LogAction.RelayEvents,
        message: `Events failed after ${Constants.OUTBOX_MAX_ATTEMPTS} attempts`,
        metadata: {
          events: failedRows.map((row) => ({
            outboxId: row.id,
            companyId: row.companyId,
            eventType: row.eventType,
          })),
        },
      });
    }

    return { isSuccess: false, message, publishedCount: 0, failedCount: params.outboxIds.length };
  }
}
