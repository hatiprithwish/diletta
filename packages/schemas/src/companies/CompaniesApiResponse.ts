import type { CompanyWithStatus } from "./CompaniesCommon";
import type { ApiResponse } from "../common";

export interface CreateCompanyApiResponse extends ApiResponse {
  company?: CompanyWithStatus;
}

export interface GetCompanyApiResponse extends ApiResponse {
  company?: CompanyWithStatus;
}

export interface GetCompaniesApiResponse extends ApiResponse {
  companies?: CompanyWithStatus[];
}

export interface UpdateCompanyApiResponse extends ApiResponse {
  company?: CompanyWithStatus;
}

export interface UpdateCompanyStatusApiResponse extends ApiResponse {
  company?: CompanyWithStatus;
}
