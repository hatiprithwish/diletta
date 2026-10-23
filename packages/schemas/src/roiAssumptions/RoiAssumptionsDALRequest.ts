import type { RoiAssumption } from "./RoiAssumptionsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateRoiAssumptionDALRequest = Pick<
  RoiAssumption,
  "companyId" | "taskType" | "manualMinutes" | "effectiveFrom" | "createdBy"
>;

// Every row of the company (a handful per task), for the minutes in force on each day
export type GetRoiAssumptionsDALRequest = Pick<RoiAssumption, "companyId">;
