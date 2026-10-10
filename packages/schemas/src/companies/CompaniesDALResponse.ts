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
