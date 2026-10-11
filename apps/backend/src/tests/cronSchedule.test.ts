import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";
import CronScheduleProvider from "@/providers/cronSchedule";
import runActivityLogPartitions from "@/crons/ActivityLogPartitionsCron";
import runKnowledgeResync from "@/crons/KnowledgeResyncCron";
import runModelCallUsageBackfill from "@/crons/ModelCallUsageBackfillCron";
import runOutboxSweep from "@/crons/OutboxSweepCron";
import worker from "@/index";

// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: The jobs are mocked: these tests check which run when, not what they do (each has its own tests)
vi.mock("@/crons/OutboxSweepCron", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/crons/ModelCallUsageBackfillCron", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/crons/KnowledgeResyncCron", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/crons/ActivityLogPartitionsCron", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

const { OutboxSweep, ModelCallUsageBackfill, KnowledgeResync, ActivityLogPartitions } =
  Schemas.CronJobEnum;
const at = (iso: string) => Date.parse(iso);

describe("CronScheduleProvider.getDueJobs", () => {
  it("runs the every-minute jobs on every minute", () => {
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T14:37:00Z"))).toEqual([
      OutboxSweep,
      ModelCallUsageBackfill,
    ]);
  });

  it("adds the knowledge re-sync at the top of every hour", () => {
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T14:00:00Z"))).toEqual([
      OutboxSweep,
      ModelCallUsageBackfill,
      KnowledgeResync,
    ]);
  });

  it("adds the partition maintenance at 03:00 UTC only", () => {
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T03:00:00Z"))).toEqual([
      OutboxSweep,
      ModelCallUsageBackfill,
      KnowledgeResync,
      ActivityLogPartitions,
    ]);
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T03:01:00Z"))).not.toContain(
      ActivityLogPartitions,
    );
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T15:00:00Z"))).not.toContain(
      ActivityLogPartitions,
    );
  });

  it("reads the time in UTC, whatever the offset it is written in", () => {
    // 03:00 UTC written as 08:30 in UTC+05:30
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T08:30:00+05:30"))).toContain(
      ActivityLogPartitions,
    );
    // 08:30 UTC is neither the top of an hour nor 03:00
    expect(CronScheduleProvider.getDueJobs(at("2026-10-11T08:30:00Z"))).toEqual([
      OutboxSweep,
      ModelCallUsageBackfill,
    ]);
  });
});

describe("scheduled()", () => {
  const run = (cron: string, iso: string) =>
    worker.scheduled(
      { cron, scheduledTime: at(iso), noRetry: () => {} },
      env,
      createExecutionContext(),
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs exactly the jobs due at the trigger's scheduled time", async () => {
    await run(Constants.CRON_TRIGGER, "2026-10-11T03:00:00Z");
    expect(runOutboxSweep).toHaveBeenCalledTimes(1);
    expect(runModelCallUsageBackfill).toHaveBeenCalledTimes(1);
    expect(runKnowledgeResync).toHaveBeenCalledTimes(1);
    expect(runActivityLogPartitions).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await run(Constants.CRON_TRIGGER, "2026-10-11T03:01:00Z");
    expect(runOutboxSweep).toHaveBeenCalledTimes(1);
    expect(runKnowledgeResync).not.toHaveBeenCalled();
    expect(runActivityLogPartitions).not.toHaveBeenCalled();
  });

  it("keeps running the other jobs when one fails", async () => {
    vi.mocked(runOutboxSweep).mockRejectedValueOnce(new Error("sweep failed"));
    await run(Constants.CRON_TRIGGER, "2026-10-11T14:00:00Z");
    expect(runModelCallUsageBackfill).toHaveBeenCalledTimes(1);
    expect(runKnowledgeResync).toHaveBeenCalledTimes(1);
  });

  it("runs nothing for an expression it doesn't know, and logs it", async () => {
    await run("0 3 * * *", "2026-10-11T03:00:00Z");
    expect(runOutboxSweep).not.toHaveBeenCalled();
    expect(runActivityLogPartitions).not.toHaveBeenCalled();
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { cron: "0 3 * * *" } }),
    );
  });
});
