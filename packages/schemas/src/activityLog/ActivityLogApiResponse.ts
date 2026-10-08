import type { ApiResponse } from "../common";

// DEV_NOTE: No ApiRequest file: partition maintenance runs from the Cron only, never from a client body. Server-side
// only, never a route response body.

// DEV_NOTE: createdPartitions = partitions this run created; missingMonths = months in the window (YYYY-MM, UTC) with
// no partition after the run; hasDefaultRows is null when the check itself failed. isSuccess only when no month is
// missing and the default partition is known to be empty.
export interface EnsureActivityLogPartitionsResponse extends ApiResponse {
  createdPartitions: string[];
  missingMonths: string[];
  hasDefaultRows: boolean | null;
}
