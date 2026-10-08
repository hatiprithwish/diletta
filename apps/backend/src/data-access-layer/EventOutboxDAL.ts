import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { activityLog, eventOutbox } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

const DEDUPE_KEY_CONSTRAINT = "UNQ_event_outbox_company_id_dedupe_key";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by the Repo. Writers and the
// after-commit relay run in withTenant and filter on companyId; the relay sweep and the purge run in withPlatform
// across companies, where companyId is null (pattern rule 3.15: cross-company Cron sweeps only).
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
