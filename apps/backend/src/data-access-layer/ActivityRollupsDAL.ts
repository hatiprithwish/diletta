import { and, eq, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { activityRollups } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). activity_rollups is derived (M4-2): a
// (company, day) is replaced as a whole under its advisory lock, never edited row by row.
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
}
