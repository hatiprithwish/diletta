import type { CompanyConnection } from "./CompanyConnectionsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints). The Repo maps them to API responses.
export interface CompanyConnectionDALResponse extends ApiResponse {
  companyConnection?: CompanyConnection;
}

export interface CompanyConnectionsDALResponse extends ApiResponse {
  companyConnections?: CompanyConnection[];
}
