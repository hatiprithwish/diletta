import NightlySuiteRepo from "@/repositories/NightlySuiteRepo";

// DEV_NOTE: Daily at Constants.NIGHTLY_SUITE_CHECK_UTC_HOUR (M5-5): alerts when the nightly platform suite hasn't
// finished a run lately (NightlySuiteRepo.checkRecentRun logs it). Only an env with NIGHTLY_SUITE_COMPANY_ID set (staging)
// checks anything. A missed day delays the alert a day; the suite's GitHub job still fails on its own.
export default async function runNightlySuiteCheck(env: Env): Promise<void> {
  await new NightlySuiteRepo(env).checkRecentRun({ now: new Date() });
}
