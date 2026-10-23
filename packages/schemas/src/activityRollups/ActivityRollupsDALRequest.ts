import type { ActivityRollupDay, ActivityRollupValue } from "./ActivityRollupsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type ActivityRollupDayDALRequest = { companyId: string; day: ActivityRollupDay };

export type CreateActivityRollupsDALRequest = ActivityRollupDayDALRequest & {
  values: ActivityRollupValue[];
};

// DEV_NOTE: The source reads of one day, in the source table's DAL: [start, end) on the row's own timestamp
export type ActivityRollupWindowDALRequest = { companyId: string; start: Date; end: Date };

// DEV_NOTE: The pages' read (M4-3): one owner's rows over [fromDay, toDay], both included. chatbotId null = the
// company-wide rows, never every chatbot's (they would count each group twice).
export type GetActivityRollupsDALRequest = {
  companyId: string;
  chatbotId: string | null;
  fromDay: ActivityRollupDay;
  toDay: ActivityRollupDay;
};
