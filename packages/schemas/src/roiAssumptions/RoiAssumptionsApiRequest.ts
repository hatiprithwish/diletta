import type { z } from "zod";
import { ZRoiAssumptionBase } from "./RoiAssumptionsCommon";

// DEV_NOTE: POST /dashboard/roi-assumptions: a task's new minutes, in force from today (UTC)
export const ZCreateRoiAssumptionApiRequest = ZRoiAssumptionBase;
export type CreateRoiAssumptionApiRequest = z.infer<typeof ZCreateRoiAssumptionApiRequest>;
