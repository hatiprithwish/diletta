import Constants from "@/config/Constants";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Which jobs the one cron trigger runs at a scheduled time (controller.scheduledTime, epoch ms, the minute the
// run was scheduled for, not when it started). Pure, so the schedule is unit-tested without a Worker. Times are UTC. A
// tick Cloudflare skips skips its jobs too: the hourly re-sync picks up still-due sources next hour, and partitions are
// kept months ahead with an alert when one is missing, and the change request purge empties what it missed next minute.
// Activity rollups rebuild today and yesterday every hour, so a skipped hour is caught up by the next, and the eval
// transcript sweep removes next hour what it missed. The platform case sync is idempotent (next hour writes what it
// missed); a skipped missed-suite check only delays that alert a day, while the suite's own job still fails loudly.
export default class CronScheduleProvider {
  static getDueJobs(scheduledTime: number): Schemas.CronJobEnum[] {
    const time = new Date(scheduledTime);
    const jobs = [
      Schemas.CronJobEnum.OutboxSweep,
      Schemas.CronJobEnum.ModelCallUsageBackfill,
      Schemas.CronJobEnum.ChangeRequestPurge,
    ];

    if (time.getUTCMinutes() === Constants.CRON_HOURLY_MINUTE) {
      jobs.push(
        Schemas.CronJobEnum.KnowledgeResync,
        Schemas.CronJobEnum.ActivityRollups,
        Schemas.CronJobEnum.EvalTranscriptSweep,
        Schemas.CronJobEnum.PlatformEvalCaseSync,
      );
      if (time.getUTCHours() === Constants.ACTIVITY_LOG_PARTITIONS_UTC_HOUR) {
        jobs.push(Schemas.CronJobEnum.ActivityLogPartitions);
      }
      if (time.getUTCHours() === Constants.NIGHTLY_SUITE_CHECK_UTC_HOUR) {
        jobs.push(Schemas.CronJobEnum.NightlySuiteCheck);
      }
    }
    return jobs;
  }
}
