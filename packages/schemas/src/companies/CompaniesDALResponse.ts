import type { Company } from "./CompaniesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface CompanyDALResponse extends ApiResponse {
  company?: Company;
}

export interface CompaniesDALResponse extends ApiResponse {
  companies?: Company[];
}

// DEV_NOTE: Server-side only (never a route response): the internal companies.id of a company an operator route names
// by public id, the withTenant key for the rest of the request
export interface CompanyIdResponse extends ApiResponse {
  companyId?: string;
}

// DEV_NOTE: Server-side only: internal ids of every company in some statuses, for a sweep across companies (withPlatform)
export type CompanyRetentionRow = Pick<Company, "id" | "publicId" | "contentRetentionDays">;

export interface CompaniesRetentionDALResponse extends ApiResponse {
  companies?: CompanyRetentionRow[];
}

export interface CompanyIdsDALResponse extends ApiResponse {
  companyIds?: string[];
}

// DEV_NOTE: Server-side only: the companies an operator may act in (ADR 0006), for the dashboard's company picker
export type ActingCompanyRow = Pick<Company, "publicId" | "name" | "status">;
export interface ActingCompaniesDALResponse extends ApiResponse {
  companies?: ActingCompanyRow[];
}

// DEV_NOTE: Server-side only: the company an operator's X-Acting-Company names, resolved before withTenant
export interface ActingCompanyResponse extends ApiResponse {
  companyId?: string;
  status?: Company["status"];
}
