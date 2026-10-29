import type { CompanyWithStatus } from "./CompaniesCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";

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

export type GetCompaniesCountApiResponse = TotalRecordsResponse;

// DEV_NOTE: The Bots page's Read-only mode switch (M4-10)
export interface ReadOnlyMode {
  isReadOnly: boolean;
}

export interface GetReadOnlyModeApiResponse extends ApiResponse {
  readOnlyMode?: ReadOnlyMode;
}

export interface UpdateReadOnlyModeApiResponse extends ApiResponse {
  readOnlyMode?: ReadOnlyMode;
}
