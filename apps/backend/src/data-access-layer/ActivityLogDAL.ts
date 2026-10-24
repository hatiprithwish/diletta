import { and, asc, count, eq, gte, inArray, lt } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  activityLog,
  changeRequests,
  companies,
  conversations,
  toolCalls,
  toolDefinitions,
} from "@/db/tables";
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

  // DEV_NOTE: Activity rollups (M4-2): change_request events written in [start, end) for the actions the rollup counts,
  // per chatbot (the change request's conversation), action and tool name. activity_log is partitioned by created_at,
  // so the range reads one or two partitions.
  async getChangeRequestRollupGroups(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ActivityRollupWindowDALRequest,
  ) {
    const response: Schemas.ChangeRequestRollupGroupsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(activityLog.companyId, params.companyId),
        eq(changeRequests.companyId, params.companyId),
        eq(toolCalls.companyId, params.companyId),
        eq(toolDefinitions.companyId, params.companyId),
        eq(conversations.companyId, params.companyId),
        eq(activityLog.entityType, Schemas.CHANGE_REQUEST_ENTITY_TYPE),
        inArray(activityLog.entityAction, [...Schemas.ACTIVITY_ROLLUP_CHANGE_REQUEST_ACTIONS]),
        gte(activityLog.createdAt, params.start),
        lt(activityLog.createdAt, params.end),
      ];
      const rows = await tx
        .select({
          chatbotId: conversations.chatbotId,
          action: activityLog.entityAction,
          toolName: toolDefinitions.name,
          actorType: activityLog.actorType,
          count: count(),
        })
        .from(activityLog)
        .innerJoin(changeRequests, eq(changeRequests.id, activityLog.entityId))
        .innerJoin(toolCalls, eq(toolCalls.id, changeRequests.toolCallId))
        .innerJoin(toolDefinitions, eq(toolDefinitions.id, toolCalls.toolId))
        .innerJoin(conversations, eq(conversations.id, changeRequests.conversationId))
        .where(and(...conditions))
        .groupBy(
          conversations.chatbotId,
          activityLog.entityAction,
          toolDefinitions.name,
          activityLog.actorType,
        );

      // DEV_NOTE: entity_action is text; the query matched only counted actions, so find() narrows every row
      const groups: Schemas.ChangeRequestRollupGroup[] = [];
      for (const row of rows) {
        const action = Schemas.ACTIVITY_ROLLUP_CHANGE_REQUEST_ACTIONS.find(
          (item) => item === row.action,
        );
        if (action) {
          groups.push({
            chatbotId: row.chatbotId,
            action,
            toolName: row.toolName,
            isByChatbotUser: row.actorType === Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
            count: row.count,
          });
        }
      }

      response.isSuccess = true;
      response.message = "Change request rollup groups fetched successfully";
      response.groups = groups;
    } catch (error) {
      const message = "Unknown error in fetching change request rollup groups";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChangeRequestRollupGroups,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
