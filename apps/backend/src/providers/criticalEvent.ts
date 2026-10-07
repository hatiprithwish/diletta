import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as Schemas from "@app/schemas";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import EventOutboxDAL from "@/data-access-layer/EventOutboxDAL";

// DEV_NOTE: The one writer of critical events (pattern rule 3.5): the activity_log row and the event_outbox row that
// publishes it, in the caller's tx (pattern rule 1.1: a provider may call a DAL inside the Repo's transaction, never
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
    // so the caller's change commits. A concurrent writer of the same key loses on the unique index instead.
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
}
