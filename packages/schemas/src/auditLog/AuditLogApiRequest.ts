import { z } from "zod";
import { ZPageApiRequest } from "../common";
import { AuditLogSortColumn } from "./AuditLogCommon";

// GET /dashboard/audit-log: a page of the company's audit rows, newest first by default
export const ZGetAuditLogApiRequest = ZPageApiRequest.extend({
  sortColumn: z.enum(AuditLogSortColumn).nullable().optional(),
});
export type GetAuditLogApiRequest = z.infer<typeof ZGetAuditLogApiRequest>;
