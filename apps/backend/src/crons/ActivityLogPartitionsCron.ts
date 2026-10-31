import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import ActivityLogPartitionsRepo from "@/repositories/ActivityLogPartitionsRepo";

// DEV_NOTE: Daily at 03:00 UTC (CronScheduleProvider, Constants.ACTIVITY_LOG_PARTITIONS_UTC_HOUR): make sure activity_log has a
// partition for the current UTC month and the next ACTIVITY_LOG_PARTITION_MONTHS_AHEAD. Goes through
// ActivityLogPartitionsRepo, never a DAL (pattern rule 1.1). The Repo alerts on a missing month or a non-empty
// default partition; the next run retries.
export default async function runActivityLogPartitions(env: Env): Promise<void> {
  const result = await new ActivityLogPartitionsRepo(env).ensurePartitions({ now: new Date() });

  if (result.createdPartitions.length > 0) {
    AppLogger.info({
      category: Schemas.LogCategory.Partition,
      action: Schemas.LogAction.EnsureActivityLogPartitions,
      message: "activity_log partitions created",
      metadata: { createdPartitions: result.createdPartitions },
    });
  }
}
