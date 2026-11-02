import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import KeyRotationRepo from "@/repositories/KeyRotationRepo";

// DEV_NOTE: Every cron tick (M6-3): move values off Retiring company keys, destroy each key once nothing is left on it,
// and re-wrap company keys under the current master key. Goes through KeyRotationRepo, never a DAL. What it doesn't
// reach or fails on stays Retiring (or on the old master key), so a missed tick only delays a rotation by a tick; the
// Repo alerts when one falls too far behind.
export default async function runKeyRotationSweep(env: Env): Promise<void> {
  const swept = await new KeyRotationRepo(env).sweep();
  if (
    !swept.isSuccess ||
    swept.reEncryptedCount ||
    swept.retiredCount ||
    swept.rewrappedCount ||
    swept.failedCount
  ) {
    const entry = {
      category: Schemas.LogCategory.Crypto,
      action: Schemas.LogAction.SweepKeyRotation,
      message: swept.message ?? "Encryption keys swept",
      metadata: {
        reEncryptedCount: swept.reEncryptedCount ?? 0,
        retiredCount: swept.retiredCount ?? 0,
        rewrappedCount: swept.rewrappedCount ?? 0,
        failedCount: swept.failedCount ?? 0,
        overdueCompanyCount: swept.overdueCompanyCount ?? 0,
      },
    };
    if (swept.isSuccess && !swept.failedCount) {
      AppLogger.info(entry);
    } else {
      AppLogger.error(entry);
    }
  }
}
