import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { activityRollups } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). activity_rollups is derived (M4-2): a
// (company, day) is replaced as a whole under its advisory lock, never edited row by row. The Insights pages (M4-3)
// only read it (getActivityRollups).
export default class ActivityRollupsDAL {
  // DEV_NOTE: Transaction-scoped advisory lock on (company, day), held until the Repo's transaction ends. The hourly
  // run and an operator rebuild of the same day take turns, so the second deletes the first one's rows instead of
  // racing it to UNQ_activity_rollups_company_id_chatbot_id_day_metric.
  async lockActivityRollupDay(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ActivityRollupDayDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const lockKey = `activity_rollups:${params.companyId}:${params.day}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      response.isSuccess = true;
      response.message = "Activity rollup day locked successfully";
    } catch (error) {
      const message = "Unknown error in locking activity rollup day";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.LockActivityRollupDay,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async deleteActivityRollupDay(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ActivityRollupDayDALRequest,
  ) {
    const response: Schemas.ActivityRollupsWriteDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(activityRollups.companyId, params.companyId),
        eq(activityRollups.day, params.day),
      ];
      const deleted = await tx
        .delete(activityRollups)
        .where(and(...conditions))
        .returning({ id: activityRollups.id });

      response.isSuccess = true;
      response.message = "Activity rollup day deleted successfully";
      response.rowCount = deleted.length;
    } catch (error) {
      const message = "Unknown error in deleting activity rollup day";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteActivityRollupDay,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async createActivityRollups(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateActivityRollupsDALRequest,
  ) {
    const response: Schemas.ActivityRollupsWriteDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: A day with no activity has no rows; insert() refuses an empty values list
      if (params.values.length > 0) {
        await tx.insert(activityRollups).values(
          params.values.map((value) => ({
            companyId: params.companyId,
            chatbotId: value.chatbotId,
            day: params.day,
            metric: value.metric,
            value: value.value,
          })),
        );
      }

      response.isSuccess = true;
      response.message = "Activity rollups created successfully";
      response.rowCount = params.values.length;
    } catch (error) {
      const message = "Unknown error in creating activity rollups";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateActivityRollups,
        message,
        error,
        metadata: { companyId: params.companyId, day: params.day, rowCount: params.values.length },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: One owner's rows over a range of days (both included): a chatbot's, or the company-wide rows when
  // chatbotId is null. Served by UNQ_activity_rollups_company_id_chatbot_id_day_metric (company, chatbot, day).
  async getActivityRollups(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetActivityRollupsDALRequest,
  ) {
    const response: Schemas.ActivityRollupReadingsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(activityRollups.companyId, params.companyId),
        params.chatbotId === null
          ? isNull(activityRollups.chatbotId)
          : eq(activityRollups.chatbotId, params.chatbotId),
        gte(activityRollups.day, params.fromDay),
        lte(activityRollups.day, params.toDay),
      ];
      const readings = await tx
        .select({
          day: activityRollups.day,
          metric: activityRollups.metric,
          value: activityRollups.value,
        })
        .from(activityRollups)
        .where(and(...conditions))
        .orderBy(asc(activityRollups.day), asc(activityRollups.metric));

      response.isSuccess = true;
      response.message = "Activity rollups fetched successfully";
      response.readings = readings;
    } catch (error) {
      const message = "Unknown error in fetching activity rollups";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetActivityRollups,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every chatbot's rows of the company over [fromDay, toDay] (chatbot_id set; the company-wide rows would
  // count each group twice), for the daily health check (M5-5)
  async getChatbotHealthRollups(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotHealthRollupsDALRequest,
  ) {
    const response: Schemas.ChatbotHealthRollupsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(activityRollups.companyId, params.companyId),
        isNotNull(activityRollups.chatbotId),
        gte(activityRollups.day, params.fromDay),
        lte(activityRollups.day, params.toDay),
      ];
      const rows = await tx
        .select({
          chatbotId: activityRollups.chatbotId,
          day: activityRollups.day,
          metric: activityRollups.metric,
          value: activityRollups.value,
        })
        .from(activityRollups)
        .where(and(...conditions))
        .orderBy(
          asc(activityRollups.chatbotId),
          asc(activityRollups.day),
          asc(activityRollups.metric),
        );

      response.isSuccess = true;
      response.message = "Chatbot health rollups fetched successfully";
      response.rows = rows.flatMap((row) =>
        row.chatbotId === null ? [] : [{ ...row, chatbotId: row.chatbotId }],
      );
    } catch (error) {
      const message = "Unknown error in fetching chatbot health rollups";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotHealthRollups,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
