import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ActivityLogPartitionsDAL from "@/data-access-layer/ActivityLogPartitionsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: activity_log partition maintenance (M1-9), run by the daily Cron. Keeps a monthly partition for the
// current UTC month and the ACTIVITY_LOG_PARTITION_MONTHS_AHEAD months after it; creating one is a no-op when it
// exists. A row whose month has no partition lands in activity_log_default, and that month's partition can't be
// created while it's there, so both a month still missing after the run and any row in the default partition alert
// (error log → Sentry, M6-6). A failed month leaves the window short; the next day's run retries it, with weeks to
// spare before the month starts. The partition set spans every company, so each step runs in withPlatform
// (pattern rule 3.15): one transaction per month, so a failed create rolls back alone and holds its lock on
// activity_log only for its own statement.
export default class ActivityLogPartitionsRepo {
  private db: NodePgDatabase;
  private dal: ActivityLogPartitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ActivityLogPartitionsDAL();
  }

  // DEV_NOTE: now is the run's clock (the Cron passes the current time); the window is computed from its UTC month
  async ensurePartitions(params: {
    now: Date;
  }): Promise<Schemas.EnsureActivityLogPartitionsResponse> {
    const createdPartitions: string[] = [];
    const missingMonths: string[] = [];

    for (let offset = 0; offset <= Constants.ACTIVITY_LOG_PARTITION_MONTHS_AHEAD; offset++) {
      const monthStart = new Date(
        Date.UTC(params.now.getUTCFullYear(), params.now.getUTCMonth() + offset, 1),
      );
      const created: Schemas.ActivityLogPartitionDALResponse = await withPlatform(
        this.db,
        async (tx) => {
          return await this.dal.createActivityLogPartition(tx, { monthStart });
        },
      );

      if (!created.isSuccess) {
        missingMonths.push(monthStart.toISOString().slice(0, 7));
      } else if (created.wasCreated && created.partitionName) {
        createdPartitions.push(created.partitionName);
      }
    }

    const defaultCheck: Schemas.ActivityLogDefaultPartitionDALResponse = await withPlatform(
      this.db,
      async (tx) => {
        return await this.dal.getActivityLogDefaultHasRows(tx);
      },
    );
    const hasDefaultRows = defaultCheck.isSuccess ? (defaultCheck.hasRows ?? null) : null;

    if (missingMonths.length > 0) {
      AppLogger.error({
        category: Schemas.LogCategory.Partition,
        action: Schemas.LogAction.EnsureActivityLogPartitions,
        message: "activity_log months without a partition",
        metadata: { missingMonths },
      });
    }

    if (hasDefaultRows !== false) {
      AppLogger.error({
        category: Schemas.LogCategory.Partition,
        action: Schemas.LogAction.EnsureActivityLogPartitions,
        message:
          hasDefaultRows === null
            ? "Could not check the activity_log default partition"
            : "activity_log default partition has rows",
      });
    }

    const isSuccess = missingMonths.length === 0 && hasDefaultRows === false;
    return {
      isSuccess,
      message: isSuccess
        ? "Partitions exist for every month in the window"
        : "Partition maintenance needs attention",
      createdPartitions,
      missingMonths,
      hasDefaultRows,
    };
  }
}
