import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The one writer of audit rows (M4-9): an admin's or operator's write on a company records
// what it did, by whom and on what, as a critical event (activity_log + event_outbox) in the Repo's
// own withTenant, next to the write. Repos call it only through recordAuditOrRollback (repositories/audit.ts), which
// throws TenantRollbackError when it fails, so a write never commits without its row; it returns the outboxId, which
// the route relays after the commit. The dedupe key's ULID is fresh per call (auditEventDedupeKey: unique, never a
// dedupe). The detail is the label only (ZAuditEventDetail): never chat text, values or secrets. Like every provider it
// takes the Repo's tx and never throws. recordMany (M7-8) records a batch the same way.
export default class AuditEventProvider {
  private static toCriticalEvent(params: Schemas.AuditEventRecord): Schemas.CriticalEventBase {
    const detail: Schemas.AuditEventDetail = {
      label: params.label === null ? null : params.label.slice(0, Schemas.AUDIT_LABEL_MAX_CHARS),
    };
    return {
      actorType: params.actor.actorType,
      actorId: params.actor.actorId,
      entityType: params.entityType,
      entityId: params.entityId,
      entityAction: params.entityAction,
      entityVersion: params.entityVersion ?? null,
      parentLogId: null,
      rootLogId: null,
      detail,
      eventType: Schemas.auditEventType(params.entityType, params.entityAction),
      dedupeKey: Schemas.auditEventDedupeKey(
        params.entityType,
        params.entityAction,
        params.entityPublicId,
        Utility.generateUlid(),
      ),
    };
  }

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.AuditEventRecord & { companyId: string },
  ): Promise<Schemas.RecordAuditEventResponse> {
    try {
      const recorded = await CriticalEventProvider.record(tx, {
        companyId: params.companyId,
        ...AuditEventProvider.toCriticalEvent(params),
      });
      if (!recorded.isSuccess || !recorded.outboxId) {
        return { isSuccess: false, message: recorded.message ?? "Audit event not recorded" };
      }
      return { isSuccess: true, message: "Audit event recorded", outboxId: recorded.outboxId };
    } catch (error) {
      const message = "Unknown error in recording audit event";
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.RecordAuditEvent,
        message,
        error,
        metadata: {
          companyId: params.companyId,
          entityType: params.entityType,
          entityAction: params.entityAction,
          entityPublicId: params.entityPublicId,
        },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: M7-8. record for many writes of one company in one batch (CriticalEventProvider.recordMany): a write that
  // changes many rows at once (a tool set's load) still records one row per change, without a round trip each
  static async recordMany(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; events: Schemas.AuditEventRecord[] },
  ): Promise<Schemas.RecordAuditEventsResponse> {
    try {
      const recorded = await CriticalEventProvider.recordMany(tx, {
        companyId: params.companyId,
        events: params.events.map((event) => AuditEventProvider.toCriticalEvent(event)),
      });
      if (!recorded.isSuccess || !recorded.outboxIds) {
        return { isSuccess: false, message: recorded.message ?? "Audit events not recorded" };
      }
      return { isSuccess: true, message: "Audit events recorded", outboxIds: recorded.outboxIds };
    } catch (error) {
      const message = "Unknown error in recording audit events";
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.RecordAuditEvents,
        message,
        error,
        metadata: { companyId: params.companyId, eventCount: params.events.length },
      });
      return { isSuccess: false, message };
    }
  }
}
