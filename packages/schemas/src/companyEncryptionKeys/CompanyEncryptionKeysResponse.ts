import type { ApiResponse } from "../common";

// DEV_NOTE: The key rotation job's run (M6-3): values moved to the active key, keys destroyed (rotation done), keys
// re-wrapped under the current master key, values or keys that failed (left for the next run), and companies with a key
// Retiring past KEY_ROTATION_OVERDUE_ALERT_MS (alerted)
export interface KeyRotationSweepResponse extends ApiResponse {
  reEncryptedCount?: number;
  retiredCount?: number;
  rewrappedCount?: number;
  failedCount?: number;
  overdueCompanyCount?: number;
}

// DEV_NOTE: One batch of one column (one transaction): rows read, moved to the active key, failed (left on the old key),
// and the last id read, where the next batch starts
export interface ReEncryptBatchResponse extends ApiResponse {
  readCount?: number;
  reEncryptedCount?: number;
  failedCount?: number;
  lastId?: string | null;
}

// DEV_NOTE: The rotation's last step: isRetired false = a value is still on the key (nothing written); outboxId = the
// Retired audit row to relay
export interface RetireCompanyKeyResponse extends ApiResponse {
  isRetired?: boolean;
  outboxId?: string;
}
