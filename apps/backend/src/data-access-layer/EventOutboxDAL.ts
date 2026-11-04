import { and, asc, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { activityLog, eventOutbox } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

const DEDUPE_KEY_CONSTRAINT = "UNQ_event_outbox_company_id_dedupe_key";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by the Repo. Writers and the
// after-commit relay run in withTenant and filter on companyId; the relay sweep and the purge run in withPlatform
// across companies, where companyId is null (cross-company Cron sweeps only).
export default class EventOutboxDAL {
  async createEventOutbox(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateEventOutboxDALRequest,
  ) {
    const response: Schemas.EventOutboxDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const conditions = [
        eq(activityLog.id, params.activityLogId),
        eq(activityLog.companyId, params.companyId),
      ];
      const [logRow] = await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(...conditions))
        .limit(1);

      if (!logRow) {
        const message = "Activity log not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEventOutbox,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [eventOutboxResponse] = await tx
        .insert(eventOutbox)
        .values({
          companyId: params.companyId,
          activityLogId: params.activityLogId,
          eventType: params.eventType,
          dedupeKey: params.dedupeKey,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Event outbox created successfully";
      response.eventOutbox = eventOutboxResponse;
    } catch (error) {
      // DEV_NOTE: Backstop only: the provider holds the dedupe-key lock and checks the key first, so a writer that
      // skips that step is the only way here. The failed insert has aborted the transaction, so the caller rolls back.
      const message = Utility.isUniqueViolation(error, DEDUPE_KEY_CONSTRAINT)
        ? "Event already recorded"
        : "Unknown error in creating event outbox";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateEventOutbox,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: M7-8. createEventOutbox for many events of one company in one insert (CriticalEventProvider.recordMany),
  // with the activity log reference checked once for the batch
  async createEventOutboxes(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateEventOutboxesDALRequest,
  ) {
    const response: Schemas.EventOutboxesDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, eventCount: params.events.length };

    try {
      const logIds = [...new Set(params.events.map((event) => event.activityLogId))];
      const conditions = [
        inArray(activityLog.id, logIds),
        eq(activityLog.companyId, params.companyId),
      ];
      const [found] = await tx
        .select({ total: count() })
        .from(activityLog)
        .where(and(...conditions));

      if ((found?.total ?? 0) !== logIds.length) {
        const message = "Activity log not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEventOutboxes,
          message,
          metadata,
        });
        response.message = message;
        return response;
      }

      const eventOutboxes = await tx
        .insert(eventOutbox)
        .values(params.events.map((event) => ({ ...event, companyId: params.companyId })))
        .returning();

      response.isSuccess = true;
      response.message = "Event outboxes created successfully";
      response.eventOutboxes = eventOutboxes;
    } catch (error) {
      // DEV_NOTE: Backstop only, as for one row: the provider locks and checks every key first
      const message = Utility.isUniqueViolation(error, DEDUPE_KEY_CONSTRAINT)
        ? "Event already recorded"
        : "Unknown error in creating event outboxes";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateEventOutboxes,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: M7-8. findEventOutboxByDedupeKey for many keys: the rows that exist, in no order
  async findEventOutboxesByDedupeKeys(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindEventOutboxesByDedupeKeysDALRequest,
  ) {
    const response: Schemas.EventOutboxesDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, keyCount: params.dedupeKeys.length };

    try {
      const conditions = [
        eq(eventOutbox.companyId, params.companyId),
        inArray(eventOutbox.dedupeKey, params.dedupeKeys),
      ];
      const eventOutboxes = await tx
        .select()
        .from(eventOutbox)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Event outboxes fetched successfully";
      response.eventOutboxes = eventOutboxes;
    } catch (error) {
      const message = "Unknown error in fetching event outboxes by dedupe keys";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEventOutboxesByDedupeKeys,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: M7-8. lockEventOutboxDedupeKey for many keys in one statement, the same lock key per dedupe key, taken in
  // key order so two batches can't deadlock
  async lockEventOutboxDedupeKeys(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.LockEventOutboxDedupeKeysDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKeys = [...new Set(params.dedupeKeys)]
        .map((dedupeKey) => `event_outbox:${params.companyId}:${dedupeKey}`)
        .sort()
        .map((lockKey) => sql`${lockKey}`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(lock_key, 0)) from unnest(array[${sql.join(lockKeys, sql`, `)}]::text[]) with ordinality as keys(lock_key, position) order by position`,
      );

      response.isSuccess = true;
      response.message = "Dedupe keys locked successfully";
    } catch (error) {
      const message = "Unknown error in locking event outbox dedupe keys";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockEventOutboxDedupeKeys,
        message,
        error,
        metadata: { companyId: params.companyId, keyCount: params.dedupeKeys.length },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The load test's window (M6-5): the company's outbox rows created since `since`, and how long the published
  // ones waited (published_at − created_at) in milliseconds. A row the retention purge already removed isn't counted:
  // the purge window is hours, a load run minutes.
  async getLoadWindowStats(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetLoadWindowStatsDALRequest,
  ) {
    const response: Schemas.LoadOutboxStatsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(eventOutbox.companyId, params.companyId),
        gte(eventOutbox.createdAt, params.since),
      ];
      const lagMs = sql`extract(epoch from (${eventOutbox.publishedAt} - ${eventOutbox.createdAt})) * 1000`;
      const [row] = await tx
        .select({
          eventCount: count(),
          publishedCount: sql<number>`count(${eventOutbox.publishedAt})`,
          lagP50Ms: sql<string | null>`percentile_disc(0.5) within group (order by ${lagMs})`,
          lagP95Ms: sql<string | null>`percentile_disc(0.95) within group (order by ${lagMs})`,
          lagMaxMs: sql<string | null>`max(${lagMs})`,
        })
        .from(eventOutbox)
        .where(and(...conditions));

      const eventCount = Number(row?.eventCount ?? 0);
      const publishedCount = Number(row?.publishedCount ?? 0);
      response.isSuccess = true;
      response.message = "Load window outbox stats fetched successfully";
      response.stats = {
        eventCount,
        publishedCount,
        unpublishedCount: eventCount - publishedCount,
        lagP50Ms: Number(row?.lagP50Ms ?? 0),
        lagP95Ms: Number(row?.lagP95Ms ?? 0),
        lagMaxMs: Number(row?.lagMaxMs ?? 0),
      };
    } catch (error) {
      const message = "Unknown error in fetching load window outbox stats";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetLoadOutboxStats,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Not found is a success with no eventOutbox: the writer's dedupe check, not a lookup by a client id
  async findEventOutboxByDedupeKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindEventOutboxByDedupeKeyDALRequest,
  ) {
    const response: Schemas.EventOutboxDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(eventOutbox.companyId, params.companyId),
        eq(eventOutbox.dedupeKey, params.dedupeKey),
      ];
      const [eventOutboxResponse] = await tx
        .select()
        .from(eventOutbox)
        .where(and(...conditions))
        .limit(1);

      response.isSuccess = true;
      response.message = eventOutboxResponse
        ? "Event outbox fetched successfully"
        : "No event outbox with this dedupe key";
      response.eventOutbox = eventOutboxResponse;
    } catch (error) {
      const message = "Unknown error in fetching event outbox by dedupe key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEventOutboxByDedupeKey,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Transaction-scoped advisory lock on the dedupe key, released at COMMIT/ROLLBACK. A concurrent writer of
  // the same event waits here until the first one ends, then its dedupe check sees the committed row (READ COMMITTED
  // reads a fresh snapshot per statement) instead of failing on the unique index. Different keys rarely share a hash;
  // a clash only makes two writers wait on each other.
  async lockEventOutboxDedupeKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.LockEventOutboxDedupeKeyDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKey = `event_outbox:${params.companyId}:${params.dedupeKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      response.isSuccess = true;
      response.message = "Dedupe key locked successfully";
    } catch (error) {
      const message = "Unknown error in locking event outbox dedupe key";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockEventOutboxDedupeKey,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: FOR UPDATE SKIP LOCKED: a row another relay or sweep holds is skipped, not waited on, so two relays
  // never publish the same row at once. The locks hold until the Repo's transaction ends (after the send and mark).
  async lockPendingEventOutboxes(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.LockPendingEventOutboxesDALRequest,
  ) {
    const response: Schemas.EventOutboxesDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(eventOutbox.status, Schemas.EventOutboxStatusIntEnum.Pending)];
      if (params.companyId !== null) conditions.push(eq(eventOutbox.companyId, params.companyId));
      if (params.companyIds !== null)
        conditions.push(inArray(eventOutbox.companyId, params.companyIds));
      if (params.outboxIds !== null) conditions.push(inArray(eventOutbox.id, params.outboxIds));
      if (params.createdBefore !== null)
        conditions.push(lt(eventOutbox.createdAt, params.createdBefore));

      const eventOutboxes = await tx
        .select()
        .from(eventOutbox)
        .where(and(...conditions))
        .orderBy(asc(eventOutbox.createdAt), asc(eventOutbox.id))
        .limit(params.limit)
        .for("update", { skipLocked: true });

      response.isSuccess = true;
      response.message = "Pending event outboxes locked successfully";
      response.eventOutboxes = eventOutboxes;
    } catch (error) {
      const message = "Unknown error in locking pending event outboxes";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockPendingEventOutboxes,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async markEventOutboxesPublished(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.MarkEventOutboxesPublishedDALRequest,
  ) {
    const response: Schemas.EventOutboxesDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const conditions = [
        inArray(eventOutbox.id, params.outboxIds),
        eq(eventOutbox.status, Schemas.EventOutboxStatusIntEnum.Pending),
      ];
      if (params.companyId !== null) conditions.push(eq(eventOutbox.companyId, params.companyId));

      const eventOutboxes = await tx
        .update(eventOutbox)
        .set({
          status: Schemas.EventOutboxStatusIntEnum.Published,
          publishedAt: now,
          lastError: null,
        })
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Event outboxes marked published successfully";
      response.eventOutboxes = eventOutboxes;
    } catch (error) {
      const message = "Unknown error in marking event outboxes published";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.MarkEventOutboxesPublished,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async setEventOutboxLastError(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetEventOutboxLastErrorDALRequest,
  ) {
    const response: Schemas.EventOutboxesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        inArray(eventOutbox.id, params.outboxIds),
        eq(eventOutbox.status, Schemas.EventOutboxStatusIntEnum.Pending),
      ];
      if (params.companyId !== null) conditions.push(eq(eventOutbox.companyId, params.companyId));

      const eventOutboxes = await tx
        .update(eventOutbox)
        .set({ lastError: params.lastError })
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Event outbox last error recorded successfully";
      response.eventOutboxes = eventOutboxes;
    } catch (error) {
      const message = "Unknown error in recording event outbox last error";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetEventOutboxLastError,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Returns every updated row; the Repo alerts on the ones that reached Failed
  async markEventOutboxAttemptFailed(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.MarkEventOutboxAttemptFailedDALRequest,
  ) {
    const response: Schemas.EventOutboxesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        inArray(eventOutbox.id, params.outboxIds),
        eq(eventOutbox.status, Schemas.EventOutboxStatusIntEnum.Pending),
      ];
      if (params.companyId !== null) conditions.push(eq(eventOutbox.companyId, params.companyId));

      const eventOutboxes = await tx
        .update(eventOutbox)
        .set({
          attempts: sql`${eventOutbox.attempts} + 1`,
          lastError: params.lastError,
          status: sql`CASE WHEN ${eventOutbox.attempts} + 1 >= ${params.maxAttempts} THEN ${Schemas.EventOutboxStatusIntEnum.Failed} ELSE ${eventOutbox.status} END`,
        })
        .where(and(...conditions))
        .returning();

      response.isSuccess = true;
      response.message = "Event outbox attempts recorded successfully";
      response.eventOutboxes = eventOutboxes;
    } catch (error) {
      const message = "Unknown error in recording event outbox attempt";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.MarkEventOutboxAttemptFailed,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Outbox health across companies (M6-6, withPlatform): the oldest Pending row's created_at and the Pending
  // and Failed counts, in one read
  async getEventOutboxHealth(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetEventOutboxHealthDALRequest,
  ) {
    const response: Schemas.EventOutboxHealthDALResponse = { isSuccess: false };

    try {
      const conditions = [
        inArray(eventOutbox.status, [
          Schemas.EventOutboxStatusIntEnum.Pending,
          Schemas.EventOutboxStatusIntEnum.Failed,
        ]),
      ];
      if (params.companyIds !== null)
        conditions.push(inArray(eventOutbox.companyId, params.companyIds));
      const isPending = sql`${eventOutbox.status} = ${Schemas.EventOutboxStatusIntEnum.Pending}`;
      const [row] = await tx
        .select({
          oldestPendingCreatedAt: sql<
            Date | string | null
          >`min(${eventOutbox.createdAt}) filter (where ${isPending})`,
          pendingCount: sql<string>`count(*) filter (where ${isPending})`,
          failedCount: sql<string>`count(*) filter (where ${eventOutbox.status} = ${Schemas.EventOutboxStatusIntEnum.Failed})`,
        })
        .from(eventOutbox)
        .where(and(...conditions));

      const oldest = row?.oldestPendingCreatedAt ?? null;
      response.isSuccess = true;
      response.message = "Event outbox health fetched successfully";
      response.health = {
        oldestPendingCreatedAt: oldest === null ? null : new Date(oldest),
        pendingCount: Number(row?.pendingCount ?? 0),
        failedCount: Number(row?.failedCount ?? 0),
      };
    } catch (error) {
      const message = "Unknown error in fetching event outbox health";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetEventOutboxHealth,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deletePublishedEventOutboxes(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.DeletePublishedEventOutboxesDALRequest,
  ) {
    const response: Schemas.DeletedEventOutboxesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(eventOutbox.status, Schemas.EventOutboxStatusIntEnum.Published),
        lt(eventOutbox.publishedAt, params.publishedBefore),
      ];
      if (params.companyIds !== null)
        conditions.push(inArray(eventOutbox.companyId, params.companyIds));
      const deleted = await tx
        .delete(eventOutbox)
        .where(and(...conditions))
        .returning({ id: eventOutbox.id });

      response.isSuccess = true;
      response.message = "Published event outboxes deleted successfully";
      response.deletedCount = deleted.length;
    } catch (error) {
      const message = "Unknown error in deleting published event outboxes";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeletePublishedEventOutboxes,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
