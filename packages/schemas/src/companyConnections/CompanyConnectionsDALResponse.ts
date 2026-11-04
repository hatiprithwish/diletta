import type { CompanyConnection } from "./CompanyConnectionsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids + enum ints). The Repo maps them to API responses.
// DEV_NOTE: isIssuerTaken = the write hit UNQ_company_connections_jwt_issuer (another connection, any company, has it)
export interface CompanyConnectionDALResponse extends ApiResponse {
  companyConnection?: CompanyConnection;
  isIssuerTaken?: boolean;
}

export interface CompanyConnectionsDALResponse extends ApiResponse {
  companyConnections?: CompanyConnection[];
}

// DEV_NOTE: Server-side only: one row per company and environment with an active connection
export interface ConnectionEnvironmentsDALResponse extends ApiResponse {
  environments?: Pick<CompanyConnection, "companyId" | "environment">[];
}
