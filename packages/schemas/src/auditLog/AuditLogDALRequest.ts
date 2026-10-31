import type { PageDALRequest } from "../common";
import type { AuditLogSortColumn } from "./AuditLogCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type GetAuditLogDALRequest = PageDALRequest & {
  companyId: string;
  sortColumn: AuditLogSortColumn;
};

export interface GetAuditLogCountDALRequest {
  companyId: string;
}
