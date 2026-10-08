import type { ActivityLog, ActivityLogBase } from "./ActivityLogCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateActivityLogDALRequest = ActivityLogBase & Pick<ActivityLog, "companyId">;
