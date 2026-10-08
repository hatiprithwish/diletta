import type { NullableDALFields } from "../common";
import type { CompanyConnection, CompanyConnectionBase } from "./CompanyConnectionsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateCompanyConnectionDALRequest = CompanyConnectionBase &
  Pick<CompanyConnection, "companyId">;

// Params to find a company connection by its public ID within one company
export type FindCompanyConnectionDALRequest = Pick<CompanyConnection, "publicId" | "companyId">;

// DEV_NOTE: Pre-tenant lookup (widget auth, withPlatform): the token's iss picks the row before any company is
// known, so this is the one connection request without companyId
export type FindCompanyConnectionByIssuerDALRequest = Pick<CompanyConnection, "jwtIssuer">;

export type GetCompanyConnectionsDALRequest = Pick<CompanyConnection, "companyId">;

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateCompanyConnectionDALRequest = FindCompanyConnectionDALRequest &
  NullableDALFields<
    Pick<CompanyConnectionBase, "baseUrl" | "authConfig" | "jwtIssuer" | "allowedOrigins"> &
      Pick<CompanyConnection, "status">
  >;
