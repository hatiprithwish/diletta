import { z } from "zod";
import {
  ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS,
  activityRollupDayCount,
  activityRollupDayKey,
  ZActivityRollupDay,
} from "./ActivityRollupsCommon";

// DEV_NOTE: Operator rebuild of one company's rollups (POST /operator/companies/:companyPublicId/rollups/rebuild).
// Both days included, oldest first, at most ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS, none after today (UTC).
export const ZRebuildActivityRollupsApiRequest = z
  .object({
    fromDay: ZActivityRollupDay,
    toDay: ZActivityRollupDay,
  })
  .refine((range) => range.fromDay <= range.toDay, {
    message: "fromDay must not be after toDay",
    path: ["toDay"],
  })
  .refine((range) => range.toDay <= activityRollupDayKey(Date.now()), {
    message: "toDay must not be in the future",
    path: ["toDay"],
  })
  .refine(
    (range) =>
      activityRollupDayCount(range.fromDay, range.toDay) <= ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS,
    {
      message: `A rebuild covers at most ${ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS} days`,
      path: ["toDay"],
    },
  );
export type RebuildActivityRollupsApiRequest = z.infer<typeof ZRebuildActivityRollupsApiRequest>;
