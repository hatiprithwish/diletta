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
// relayEvents in waitUntil. The Cron sweep publishes whatever that relay missed (a killed isolate, a Queue outage),
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
        companyIds: null,
        outboxIds: params.outboxIds,
        createdBefore: null,
        limit: params.outboxIds.length,
      });
    });
  }

  // DEV_NOTE: Cron sweep across companies: pending rows older than OUTBOX_SWEEP_MIN_AGE_MS, oldest first, one
  // transaction per batch. Stops when the Queue is unavailable (or the DB fails) and resumes next minute. companyIds
  // limits it to some companies (tests on the shared staging branch); the Cron passes null.
  async sweepPendingEvents(params: {
    companyIds: string[] | null;
  }): Promise<Schemas.RelayEventsResponse> {
    const createdBefore = new Date(Date.now() - Constants.OUTBOX_SWEEP_MIN_AGE_MS);
    let publishedCount = 0;
    let failedCount = 0;

    for (let batch = 0; batch < Constants.OUTBOX_SWEEP_MAX_BATCHES; batch++) {
      const result: Schemas.RelayEventsResponse = await withPlatform(this.db, async (tx) => {
        return await this.publishPendingEvents(tx, {
          companyId: null,
          companyIds: params.companyIds,
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
  // relay-failure runbook. companyIds as in sweepPendingEvents.
  async purgePublishedEvents(params: {
    companyIds: string[] | null;
  }): Promise<Schemas.PurgePublishedEventsResponse> {
    const publishedBefore = new Date(
      Date.now() - Constants.OUTBOX_PUBLISHED_RETENTION_DAYS * DAY_MS,
    );

    return await withPlatform(this.db, async (tx) => {
      return await this.dal.deletePublishedEventOutboxes(tx, {
        publishedBefore,
        companyIds: params.companyIds,
      });
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

    const rows = locked.eventOutboxes;
    try {
      await this.queue.sendBatch(rows.map((row) => ({ body: this.toMessage(row) })));
    } catch (batchError) {
      return await this.sendOneByOne(tx, { companyId: params.companyId, rows, batchError });
    }

    const published = await this.dal.markEventOutboxesPublished(tx, {
      companyId: params.companyId,
      outboxIds: rows.map((row) => row.id),
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

  private toMessage(row: Schemas.EventOutbox): Schemas.EventOutboxMessage {
    return {
      outboxId: row.id,
      companyId: row.companyId,
      activityLogId: row.activityLogId,
      eventType: row.eventType,
      dedupeKey: row.dedupeKey,
    };
  }

  // DEV_NOTE: A failed sendBatch doesn't say which message it choked on, so each row is retried on its own.
  // - None sent: the Queue itself is failing (an outage). Rows stay pending with lastError and no attempt counted, so
  //   an outage of any length never turns events into Failed; the sweep stops and retries next minute.
  // - Some sent: the rest were rejected for themselves (e.g. too large). Healthy rows publish; each rejected row
  //   counts an attempt and moves to Failed at OUTBOX_MAX_ATTEMPTS, so it can't hold the batch back for long.
  private async sendOneByOne(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string | null; rows: Schemas.EventOutbox[]; batchError: unknown },
  ): Promise<Schemas.RelayEventsResponse> {
    const results = await Promise.allSettled(
      params.rows.map((row) => this.queue.send(this.toMessage(row))),
    );
    const sentIds: string[] = [];
    const rejected: { outboxId: string; error: unknown }[] = [];
    results.forEach((result, index) => {
      const outboxId = params.rows[index]?.id ?? "";
      if (result.status === "fulfilled") sentIds.push(outboxId);
      else rejected.push({ outboxId, error: result.reason });
    });
    const outboxIds = params.rows.map((row) => row.id);

    if (sentIds.length === 0) {
      const message = "Queue unavailable, events left pending";
      AppLogger.error({
        category: Schemas.LogCategory.Relay,
        action: Schemas.LogAction.RelayEvents,
        message,
        error: params.batchError,
        metadata: { companyId: params.companyId, outboxIds },
      });

      const recorded = await this.dal.setEventOutboxLastError(tx, {
        companyId: params.companyId,
        outboxIds,
        lastError: this.toLastError(params.batchError),
      });
      if (!recorded.isSuccess) {
        return { isSuccess: false, message: recorded.message };
      }
      return { isSuccess: false, message, publishedCount: 0, failedCount: outboxIds.length };
    }

    const published = await this.dal.markEventOutboxesPublished(tx, {
      companyId: params.companyId,
      outboxIds: sentIds,
    });
    if (!published.isSuccess || !published.eventOutboxes) {
      return { isSuccess: false, message: published.message };
    }

    const attempted = await this.recordFailedAttempts(tx, {
      companyId: params.companyId,
      rejected,
    });
    if (!attempted.isSuccess) {
      return { isSuccess: false, message: attempted.message };
    }

    return {
      isSuccess: true,
      message: "Events published, some rejected by the Queue",
      publishedCount: published.eventOutboxes.length,
      failedCount: rejected.length,
    };
  }

  // DEV_NOTE: The rows stay pending for the next sweep until OUTBOX_MAX_ATTEMPTS, then move to Failed. A Failed row
  // is never retried automatically, so it alerts (error log → Sentry, M6-6). Rows are grouped by error message, so
  // each keeps its own lastError.
  private async recordFailedAttempts(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string | null; rejected: { outboxId: string; error: unknown }[] },
  ): Promise<Schemas.ApiResponse> {
    const byError = new Map<string, string[]>();
    for (const { outboxId, error } of params.rejected) {
      const lastError = this.toLastError(error);
      byError.set(lastError, [...(byError.get(lastError) ?? []), outboxId]);
    }

    const failedRows: Schemas.EventOutbox[] = [];
    for (const [lastError, outboxIds] of byError) {
      AppLogger.error({
        category: Schemas.LogCategory.Relay,
        action: Schemas.LogAction.RelayEvents,
        message: "Events rejected by the Queue",
        metadata: { companyId: params.companyId, outboxIds, lastError },
      });

      const attempted = await this.dal.markEventOutboxAttemptFailed(tx, {
        companyId: params.companyId,
        outboxIds,
        lastError,
        maxAttempts: Constants.OUTBOX_MAX_ATTEMPTS,
      });
      if (!attempted.isSuccess || !attempted.eventOutboxes) {
        return { isSuccess: false, message: attempted.message };
      }
      failedRows.push(
        ...attempted.eventOutboxes.filter(
          (row) => row.status === Schemas.EventOutboxStatusIntEnum.Failed,
        ),
      );
    }

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

    return { isSuccess: true, message: "Failed attempts recorded successfully" };
  }

  private toLastError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      Constants.OUTBOX_LAST_ERROR_MAX_LENGTH,
    );
  }
}
