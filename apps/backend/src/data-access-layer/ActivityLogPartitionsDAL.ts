import { sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Platform DAL for activity_log partition maintenance (M1-9) — holds no db client; every method takes the
// tx the Repo opened with withPlatform. diletta_app can't run DDL or read a partition, so both methods call the
// SECURITY DEFINER functions from *_activity_log_partition_maintenance, which run as the table owner and do one
// fixed thing each. No company's rows are read or returned, so there is no companyId.
export default class ActivityLogPartitionsDAL {
  async createActivityLogPartition(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateActivityLogPartitionDALRequest,
  ) {
    const response: Schemas.ActivityLogPartitionDALResponse = { isSuccess: false };

    try {
      const { rows } = await tx.execute<{ partition_name: string; was_created: boolean }>(
        sql`select partition_name, was_created from create_activity_log_partition(${params.monthStart.toISOString()}::timestamptz)`,
      );
      const [row] = rows;

      response.isSuccess = true;
      response.message = row.was_created ? "Partition created" : "Partition already exists";
      response.partitionName = row.partition_name;
      response.wasCreated = row.was_created;
    } catch (error) {
      // DEV_NOTE: The logged error keeps the SQLSTATE: 22023 month out of range, 42P07 a same-named table that isn't
      // a partition, 23514 rows for that month already in the default partition, 55P03 lock timeout
      const message = "Failed to create activity log partition";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateActivityLogPartition,
        message,
        error,
        metadata: { monthStart: params.monthStart.toISOString() },
      });
      response.message = message;
    }

    return response;
  }

  async getActivityLogDefaultHasRows(tx: NodePgTransaction<EmptyRelations>) {
    const response: Schemas.ActivityLogDefaultPartitionDALResponse = { isSuccess: false };

    try {
      const { rows } = await tx.execute<{ has_rows: boolean }>(
        sql`select activity_log_default_has_rows() as has_rows`,
      );
      const [row] = rows;

      response.isSuccess = true;
      response.message = "Default partition checked";
      response.hasRows = row.has_rows;
    } catch (error) {
      const message = "Failed to check the activity log default partition";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetActivityLogDefaultHasRows,
        message,
        error,
      });
      response.message = message;
    }

    return response;
  }
}
