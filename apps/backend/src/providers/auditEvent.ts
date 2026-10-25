import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The one writer of audit rows (M4-9, pattern rule 3.45): an admin's or operator's write on a company records
// what it did, by whom and on what, as a critical event (activity_log + event_outbox, pattern rule 3.5) in the Repo's
// own withTenant, next to the write. The Repo throws TenantRollbackError when it fails, so a write never commits
// without its row; it returns the outboxId, which the route relays after the commit. The detail is the label only
// (ZAuditEventDetail): never chat text, values or secrets. Like every provider it takes the Repo's tx and never throws.
export default class AuditEventProvider {
  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      actor: Schemas.AuditActor;
      entityType: Schemas.AuditEntityTypeEnum;
      entityAction: Schemas.AuditEntityActionEnum;
      entityId: string;
      entityPublicId: string;
      entityVersion?: number | null;
      label: string | null;
    },
  ): Promise<Schemas.RecordAuditEventResponse> {
    try {
      const detail: Schemas.AuditEventDetail = {
        label: params.label === null ? null : params.label.slice(0, Schemas.AUDIT_LABEL_MAX_CHARS),
      };
      const recorded = await CriticalEventProvider.record(tx, {
        companyId: params.companyId,
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
}
