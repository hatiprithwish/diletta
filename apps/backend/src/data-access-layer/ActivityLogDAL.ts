import { and, asc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { activityLog, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). activity_log is append-only: insert, and read by entity.
// Critical events reach it through CriticalEventProvider, which writes the event_outbox row in the same tx.
export default class ActivityLogDAL {
  async createActivityLog(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateActivityLogDALRequest,
  ) {
    const response: Schemas.ActivityLogDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the references before writing. actorId and entityId are
      // polymorphic (their table depends on actorType / entityType) and come from server code, so they aren't checked.
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateActivityLog,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      for (const [label, logId] of [
        ["Parent", params.parentLogId],
        ["Root", params.rootLogId],
      ] as const) {
        if (logId === null) continue;

        const conditions = [eq(activityLog.id, logId), eq(activityLog.companyId, params.companyId)];
        const [logRow] = await tx
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(...conditions))
          .limit(1);

        if (!logRow) {
          const message = `${label} activity log not found`;
          AppLogger.error({
            category: Schemas.LogCategory.DAL,
            action: Schemas.LogAction.CreateActivityLog,
            message,
            metadata: params,
          });
          response.message = message;
          return response;
        }
      }

      const [activityLogResponse] = await tx
        .insert(activityLog)
        .values({
          companyId: params.companyId,
          actorType: params.actorType,
          actorId: params.actorId,
          entityType: params.entityType,
          entityId: params.entityId,
          entityAction: params.entityAction,
          entityVersion: params.entityVersion,
          parentLogId: params.parentLogId,
          rootLogId: params.rootLogId,
          detail: params.detail,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Activity log created successfully";
      response.activityLog = activityLogResponse;
    } catch (error) {
      const message = "Unknown error in creating activity log";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateActivityLog,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The log rows of one entity, oldest first (IDX_activity_log_entity_id), at most params.limit: an entity
  // gathers a handful of events (an issue: opened, a provider added per failing key, triage)
  async getActivityLogsByEntity(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetActivityLogsByEntityDALRequest,
  ) {
    const response: Schemas.ActivityLogsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(activityLog.companyId, params.companyId),
        eq(activityLog.entityType, params.entityType),
        eq(activityLog.entityId, params.entityId),
      ];
      const activityLogs = await tx
        .select()
        .from(activityLog)
        .where(and(...conditions))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Activity logs fetched successfully";
      response.activityLogs = activityLogs;
    } catch (error) {
      const message = "Unknown error in fetching activity logs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetActivityLogsByEntity,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
