import type { CompanyConnectionWithStatus } from "./CompanyConnectionsCommon";
import type { ApiResponse } from "../common";

export interface CreateCompanyConnectionApiResponse extends ApiResponse {
  companyConnection?: CompanyConnectionWithStatus;
}

export interface GetCompanyConnectionApiResponse extends ApiResponse {
  companyConnection?: CompanyConnectionWithStatus;
}

export interface GetCompanyConnectionsApiResponse extends ApiResponse {
  companyConnections?: CompanyConnectionWithStatus[];
}

export interface UpdateCompanyConnectionApiResponse extends ApiResponse {
  companyConnection?: CompanyConnectionWithStatus;
}
