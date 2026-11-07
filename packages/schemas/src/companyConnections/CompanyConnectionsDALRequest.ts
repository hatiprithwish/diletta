import type { NullableDALFields } from "../common";
import type { CompanyConnection, CompanyConnectionBase } from "./CompanyConnectionsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CreateCompanyConnectionDALRequest = CompanyConnectionBase &
  Pick<CompanyConnection, "companyId" | "createdBy">;

// Params to find a company connection by its public ID within one company
export type FindCompanyConnectionDALRequest = Pick<CompanyConnection, "publicId" | "companyId">;

// DEV_NOTE: isForUpdate locks the row for the rest of the transaction (SELECT … FOR UPDATE), so an origins edit
// compares against a list no concurrent edit can change in between
// DEV_NOTE: By public id (a route), or by internal id (an eval run's connection, M7-9)
export type GetCompanyConnectionDetailsDALRequest = Pick<CompanyConnection, "companyId"> &
  ({ publicId: string; id?: undefined } | { id: string; publicId?: undefined }) & {
    isForUpdate?: boolean;
  };

// DEV_NOTE: Pre-tenant lookup (widget auth, withPlatform): the token's iss picks the row before any company is
// known, so this is the one connection request without companyId
export type FindCompanyConnectionByIssuerDALRequest = Pick<CompanyConnection, "jwtIssuer">;

export type GetCompanyConnectionsDALRequest = Pick<CompanyConnection, "companyId">;

// DEV_NOTE: M7-8. Cross-company (withPlatform): the operator's Companies list shows which environments each listed
// company has an active connection in
export type GetConnectionEnvironmentsDALRequest = { companyIds: string[] };

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
// DEV_NOTE: resetOp (M5-2) is the one field null can't mean "unchanged" for (null clears it): undefined = unchanged
export type UpdateCompanyConnectionDALRequest = FindCompanyConnectionDALRequest &
  NullableDALFields<
    Pick<CompanyConnectionBase, "baseUrl" | "authConfig" | "jwtIssuer" | "allowedOrigins"> &
      Pick<CompanyConnection, "status">
  > & {
    resetOp?: CompanyConnectionBase["resetOp"];
    openapiUrl?: CompanyConnectionBase["openapiUrl"];
    openapiShaping?: CompanyConnectionBase["openapiShaping"];
  } & Pick<CompanyConnection, "updatedBy">;

// DEV_NOTE: ADR 0009. What a contract sync found, written on the connection: a failure keeps the last good spec hash.
export type RecordToolContractSyncDALRequest = FindCompanyConnectionDALRequest &
  Pick<CompanyConnection, "openapiFailure"> & { openapiSpecHash?: string };

// DEV_NOTE: ADR 0009, cross-company (withPlatform): Active REST connections with a spec URL, never synced or synced
// before `syncedBefore`, least recently synced first
export type GetToolContractDueConnectionsDALRequest = { limit: number; syncedBefore: Date };
