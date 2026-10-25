import type { NullableDALFields, PageDALRequest } from "../common";
import type { Company, CompanyBase, CompanySortColumn } from "./CompaniesCommon";

export type CreateCompanyDALRequest = CompanyBase;

// DEV_NOTE: companies is the tenancy root, so a company is found by its internal id (the withTenant key)
export type FindCompanyDALRequest = { companyId: Company["id"] };

// DEV_NOTE: isForUpdate locks the row for the rest of the transaction (SELECT … FOR UPDATE), so a settings save compares
// against a value no concurrent save can change in between
export type GetCompanyDetailsDALRequest = FindCompanyDALRequest & { isForUpdate?: boolean };

// DEV_NOTE: Pre-tenant lookup (withPlatform): resolves the company named in a Clerk invite before withTenant can run
export type FindCompanyByPublicIdDALRequest = Pick<Company, "publicId">;

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateCompanyDALRequest = FindCompanyDALRequest &
  NullableDALFields<CompanyBase & Pick<Company, "status" | "isReadOnly">>;

export type GetCompaniesDALRequest = PageDALRequest & { sortColumn: CompanySortColumn };

// DEV_NOTE: Cross-company sweep (withPlatform): every company whose status is one of these
export type GetCompanyIdsByStatusDALRequest = { statuses: Company["status"][] };
