import type { ActivityRollupDay, ActivityRollupValue } from "./ActivityRollupsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type ActivityRollupDayDALRequest = { companyId: string; day: ActivityRollupDay };

export type CreateActivityRollupsDALRequest = ActivityRollupDayDALRequest & {
  values: ActivityRollupValue[];
};

// DEV_NOTE: The source reads of one day, in the source table's DAL: [start, end) on the row's own timestamp
export type ActivityRollupWindowDALRequest = { companyId: string; start: Date; end: Date };
