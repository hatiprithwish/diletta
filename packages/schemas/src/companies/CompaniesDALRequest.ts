import type { NullableDALFields, PageDALRequest } from "../common";
import type { Company, CompanyBase, CompanySortColumn } from "./CompaniesCommon";

export type CreateCompanyDALRequest = CompanyBase;

// DEV_NOTE: companies is the tenancy root, so a company is found by its internal id (the withTenant key)
export type FindCompanyDALRequest = { companyId: Company["id"] };

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateCompanyDALRequest = FindCompanyDALRequest &
  NullableDALFields<CompanyBase & Pick<Company, "status" | "isReadOnly">>;

export type GetCompaniesDALRequest = PageDALRequest & { sortColumn: CompanySortColumn };
