import type { NullableDALFields } from "../common";
import type { Company, CompanyBase } from "./CompaniesCommon";

export type CreateCompanyDALRequest = CompanyBase;

// DEV_NOTE: companies is the tenancy root, so a company is found by its internal id (the withTenant key)
export type FindCompanyDALRequest = { companyId: Company["id"] };

// DEV_NOTE: Only client-editable fields. updatedAt is set by the DAL.
export type UpdateCompanyDALRequest = FindCompanyDALRequest &
  NullableDALFields<CompanyBase & Pick<Company, "status" | "isReadOnly">>;
