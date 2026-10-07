import type { Company } from "./CompaniesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + status int). The Repo maps them to API responses.
export interface CompanyDALResponse extends ApiResponse {
  company?: Company;
}

export interface CompaniesDALResponse extends ApiResponse {
  companies?: Company[];
}
