import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as Schemas from "@app/schemas";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import EventOutboxDAL from "@/data-access-layer/EventOutboxDAL";

// DEV_NOTE: The one writer of critical events: the activity_log row and the event_outbox row that
// publishes it, in the caller's tx (a provider may call a DAL inside the Repo's transaction, never
// opening one itself). Every Repo whose change is a critical event calls it inside its own withTenant, next to the
// change, and throws TenantRollbackError when it fails, so the change, the log row and the outbox row commit
// together or not at all. After the commit, the caller relays outboxId with EventOutboxRepo.relayEvents in waitUntil;
// the Cron sweep publishes it if that relay never runs.
export default class CriticalEventProvider {
  private static activityLogDAL = new ActivityLogDAL();
  private static eventOutboxDAL = new EventOutboxDAL();

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CriticalEventBase & { companyId: string },
  ): Promise<Schemas.RecordCriticalEventResponse> {
    // DEV_NOTE: Dedupe — a retried step that already recorded this event writes nothing new and still succeeds,
    // so the caller's change commits. The key lock makes a concurrent repeat wait for the first writer's commit and
    // then take the same no-op path; if the first writer rolls back, the repeat records the event itself.
    const keyLock = await CriticalEventProvider.eventOutboxDAL.lockEventOutboxDedupeKey(tx, {
      companyId: params.companyId,
      dedupeKey: params.dedupeKey,
    });
    if (!keyLock.isSuccess) {
      return { isSuccess: false, message: keyLock.message };
    }

    const existing = await CriticalEventProvider.eventOutboxDAL.findEventOutboxByDedupeKey(tx, {
      companyId: params.companyId,
      dedupeKey: params.dedupeKey,
    });
    if (!existing.isSuccess) {
      return { isSuccess: false, message: existing.message };
    }
    if (existing.eventOutbox) {
      return {
        isSuccess: true,
        message: "Event already recorded",
        activityLogId: existing.eventOutbox.activityLogId,
        outboxId: existing.eventOutbox.id,
        wasDuplicate: true,
      };
    }

    const { eventType, dedupeKey, ...logParams } = params;
    const logged = await CriticalEventProvider.activityLogDAL.createActivityLog(tx, logParams);
    if (!logged.isSuccess || !logged.activityLog) {
      return { isSuccess: false, message: logged.message };
    }

    const outbox = await CriticalEventProvider.eventOutboxDAL.createEventOutbox(tx, {
      companyId: params.companyId,
      activityLogId: logged.activityLog.id,
      eventType,
      dedupeKey,
    });
    if (!outbox.isSuccess || !outbox.eventOutbox) {
      return { isSuccess: false, message: outbox.message };
    }

    return {
      isSuccess: true,
      message: "Event recorded successfully",
      activityLogId: logged.activityLog.id,
      outboxId: outbox.eventOutbox.id,
      wasDuplicate: false,
    };
  }

  // DEV_NOTE: M7-8. record for many events of one company, with the same dedupe (every key locked, then checked) in a
  // fixed number of statements, for a write that changes many rows at once (a tool set's load). The inserted log rows
  // come back in no promised order, so each is paired with its event by (entityType, entityId, entityAction), which
  // must be unique in the batch. Returns one outbox id per event, in order.
  static async recordMany(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; events: Schemas.CriticalEventBase[] },
  ): Promise<Schemas.RecordCriticalEventsResponse> {
    if (params.events.length === 0) {
      return { isSuccess: true, message: "No events to record", outboxIds: [] };
    }
    const entityKey = (
      event: Pick<Schemas.CriticalEventBase, "entityType" | "entityId" | "entityAction">,
    ) => `${event.entityType}:${event.entityId ?? ""}:${event.entityAction}`;
    const dedupeKeys = params.events.map((event) => event.dedupeKey);
    if (
      new Set(dedupeKeys).size !== dedupeKeys.length ||
      new Set(params.events.map(entityKey)).size !== params.events.length
    ) {
      return { isSuccess: false, message: "A batch repeats an event" };
    }

    const keyParams = { companyId: params.companyId, dedupeKeys };
    const keyLock = await CriticalEventProvider.eventOutboxDAL.lockEventOutboxDedupeKeys(
      tx,
      keyParams,
    );
    if (!keyLock.isSuccess) return { isSuccess: false, message: keyLock.message };

    const existing = await CriticalEventProvider.eventOutboxDAL.findEventOutboxesByDedupeKeys(
      tx,
      keyParams,
    );
    if (!existing.isSuccess || !existing.eventOutboxes) {
      return { isSuccess: false, message: existing.message };
    }
    const outboxIdByKey = new Map(existing.eventOutboxes.map((row) => [row.dedupeKey, row.id]));

    const fresh = params.events.filter((event) => !outboxIdByKey.has(event.dedupeKey));
    if (fresh.length > 0) {
      const logged = await CriticalEventProvider.activityLogDAL.createActivityLogs(tx, {
        companyId: params.companyId,
        logs: fresh.map(({ eventType: _eventType, dedupeKey: _dedupeKey, ...log }) => log),
      });
      if (!logged.isSuccess || !logged.activityLogs) {
        return { isSuccess: false, message: logged.message };
      }
      const logIdByEntity = new Map(logged.activityLogs.map((row) => [entityKey(row), row.id]));

      const events: Schemas.CreateEventOutboxesDALRequest["events"] = [];
      for (const event of fresh) {
        const activityLogId = logIdByEntity.get(entityKey(event));
        if (!activityLogId) return { isSuccess: false, message: "Activity log not recorded" };
        events.push({ activityLogId, eventType: event.eventType, dedupeKey: event.dedupeKey });
      }
      const outboxes = await CriticalEventProvider.eventOutboxDAL.createEventOutboxes(tx, {
        companyId: params.companyId,
        events,
      });
      if (!outboxes.isSuccess || !outboxes.eventOutboxes) {
        return { isSuccess: false, message: outboxes.message };
      }
      for (const row of outboxes.eventOutboxes) outboxIdByKey.set(row.dedupeKey, row.id);
    }

    const outboxIds: string[] = [];
    for (const key of dedupeKeys) {
      const outboxId = outboxIdByKey.get(key);
      if (!outboxId) return { isSuccess: false, message: "Event outbox not recorded" };
      outboxIds.push(outboxId);
    }
    return { isSuccess: true, message: "Events recorded successfully", outboxIds };
  }
}
