import type { PageDALRequest } from "../common";
import type { InjectionEventSortColumn } from "./SecurityCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export interface UpdateCompanyConnectionOriginsDALRequest {
  companyId: string;
  publicId: string;
  allowedOrigins: string[];
  updatedBy: string;
}

export interface UpdateCompanyContentRetentionDALRequest {
  companyId: string;
  contentRetentionDays: number;
  updatedBy: string;
}

export type GetInjectionQualityIssuesDALRequest = PageDALRequest & {
  companyId: string;
  sortColumn: InjectionEventSortColumn;
};

export interface CountInjectionQualityIssuesDALRequest {
  companyId: string;
}
