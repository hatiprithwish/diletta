// DEV_NOTE: The jobs the backend's one cron trigger runs (CronScheduleProvider.getDueJobs picks the due ones from the
// trigger's scheduled time). One trigger per Worker: the account's Workers Free plan allows 5 cron triggers in total,
// so a job's schedule lives in code, never as another wrangler.jsonc trigger.
export enum CronJobEnum {
  // Every minute
  OutboxSweep = "OutboxSweep",
  ModelCallUsageBackfill = "ModelCallUsageBackfill",
  ChangeRequestPurge = "ChangeRequestPurge",
  // Every hour, at minute Constants.CRON_HOURLY_MINUTE
  KnowledgeResync = "KnowledgeResync",
  ActivityRollups = "ActivityRollups",
  // Daily, at Constants.ACTIVITY_LOG_PARTITIONS_UTC_HOUR, minute Constants.CRON_HOURLY_MINUTE (UTC)
  ActivityLogPartitions = "ActivityLogPartitions",
}
