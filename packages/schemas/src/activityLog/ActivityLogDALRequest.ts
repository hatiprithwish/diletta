import type { ActivityLog, ActivityLogBase } from "./ActivityLogCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateActivityLogDALRequest = ActivityLogBase & Pick<ActivityLog, "companyId">;

// DEV_NOTE: Partition maintenance (M1-9) is platform work on the partition set, not on any company's rows: no
// companyId. monthStart is the first instant of a UTC month.
export interface CreateActivityLogPartitionDALRequest {
  monthStart: Date;
}
