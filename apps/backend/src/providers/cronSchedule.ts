import Constants from "@/config/Constants";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Which jobs the one cron trigger runs at a scheduled time (controller.scheduledTime, epoch ms, the minute the
// run was scheduled for, not when it started). Pure, so the schedule is unit-tested without a Worker. Times are UTC. A
// tick Cloudflare skips skips its jobs too: the hourly re-sync picks up still-due sources next hour, and partitions are
// kept months ahead with an alert when one is missing.
export default class CronScheduleProvider {
  static getDueJobs(scheduledTime: number): Schemas.CronJobEnum[] {
    const time = new Date(scheduledTime);
    const jobs = [Schemas.CronJobEnum.OutboxSweep, Schemas.CronJobEnum.ModelCallUsageBackfill];

    if (time.getUTCMinutes() === Constants.CRON_HOURLY_MINUTE) {
      jobs.push(Schemas.CronJobEnum.KnowledgeResync);
      if (time.getUTCHours() === Constants.ACTIVITY_LOG_PARTITIONS_UTC_HOUR) {
        jobs.push(Schemas.CronJobEnum.ActivityLogPartitions);
      }
    }
    return jobs;
  }
}
