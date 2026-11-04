import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { TenantRollbackError } from "@/db/withTenant";
import AuditEventProvider from "@/providers/auditEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Repo side of an audit row (M4-9), shared by every Repo that writes one: the row in
// the write's own transaction, and a TenantRollbackError when it fails, so a write never commits without it (the
// provider never throws, so the rollback lives here). Returns the outboxId the route relays after the commit. The
// action must be one its entity type records (Schemas.AUDIT_ENTITY_ACTIONS), so it always has its words in the log.
export async function recordAuditOrRollback<T extends Schemas.AuditEntityTypeEnum>(
  tx: NodePgTransaction<EmptyRelations>,
  params: {
    companyId: string;
    actor: Schemas.AuditActor;
    entityType: T;
    entityAction: Schemas.AuditEntityActionFor<T>;
    entity: { id: string; publicId: string };
    entityVersion?: number | null;
    label: string | null;
  },
): Promise<string> {
  const audited = await AuditEventProvider.record(tx, {
    companyId: params.companyId,
    actor: params.actor,
    entityType: params.entityType,
    entityAction: params.entityAction,
    entityId: params.entity.id,
    entityPublicId: params.entity.publicId,
    entityVersion: params.entityVersion,
    label: params.label,
  });
  if (!audited.isSuccess || !audited.outboxId) {
    throw new TenantRollbackError(audited.message ?? "Audit event not recorded");
  }
  return audited.outboxId;
}

// DEV_NOTE: M7-8. recordAuditOrRollback for many writes of one company in one batch (AuditEventProvider.recordMany);
// returns their outbox ids
export async function recordAuditsOrRollback<T extends Schemas.AuditEntityTypeEnum>(
  tx: NodePgTransaction<EmptyRelations>,
  params: {
    companyId: string;
    actor: Schemas.AuditActor;
    entityType: T;
    events: {
      entityAction: Schemas.AuditEntityActionFor<T>;
      entity: { id: string; publicId: string };
      entityVersion?: number | null;
      label: string | null;
    }[];
  },
): Promise<string[]> {
  if (params.events.length === 0) return [];
  const audited = await AuditEventProvider.recordMany(tx, {
    companyId: params.companyId,
    events: params.events.map((event) => ({
      actor: params.actor,
      entityType: params.entityType,
      entityAction: event.entityAction,
      entityId: event.entity.id,
      entityPublicId: event.entity.publicId,
      entityVersion: event.entityVersion,
      label: event.label,
    })),
  });
  if (!audited.isSuccess || !audited.outboxIds) {
    throw new TenantRollbackError(audited.message ?? "Audit events not recorded");
  }
  return audited.outboxIds;
}

// DEV_NOTE: The signed-in company admin as an audit actor (dashboard Repos)
export const adminAuditActor = (adminId: string): Schemas.AuditActor => ({
  actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
  actorId: adminId,
});

// DEV_NOTE: The operator as an audit actor (operator-only Repos: ToolDefinitionsRepo)
export const operatorAuditActor = (adminId: string): Schemas.AuditActor => ({
  actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
  actorId: adminId,
});

// DEV_NOTE: The signed-in caller of a /dashboard/* write: a company admin, or an operator acting in the company
// (ADR 0006), whose writes the company's audit log shows as Diletta's, never as one of its admins'
export const auditActorFor = (admin: Schemas.AdminContext): Schemas.AuditActor =>
  admin.role === Schemas.AdminRoleEnum.Operator
    ? operatorAuditActor(admin.adminId)
    : adminAuditActor(admin.adminId);

// DEV_NOTE: The platform as an audit actor: a change no person made, on Schemas.AUDIT_SYSTEM_ENTITY_TYPES only (M5-4: a
// gate run's finish moving a chatbot version, ChatbotConfigsRepo.applyGateResult)
export const systemAuditActor = (): Schemas.AuditActor => ({
  actorType: Schemas.ActivityLogActorTypeIntEnum.System,
  actorId: null,
});
