import type { Admin } from "./AdminsCommon";

// DEV_NOTE: The Clerk admin → company lookup. It runs in withPlatform before the company is known, so it is the
// one admins query that doesn't filter on companyId (pattern rule 3.15: pre-tenant lookup).
export type FindAdminByClerkUserIdDALRequest = Pick<Admin, "clerkUserId">;

// DEV_NOTE: Company admins only. Operators (companyId NULL) are never created by the app (runbook: operators.md).
export type CreateAdminDALRequest = Pick<Admin, "clerkUserId" | "email" | "name"> & {
  companyId: string;
};

// DEV_NOTE: Keeps admins.email in step with the Clerk session's email. companyId null = an operator's own row
// (withPlatform); set = a company admin's row (withTenant on that company).
export type UpdateAdminEmailDALRequest = Pick<Admin, "companyId" | "email"> & {
  adminId: Admin["id"];
};

// A company admin by internal id (who published a config, M4-3)
export type FindAdminDALRequest = { companyId: string; adminId: Admin["id"] };

// DEV_NOTE: Settings › Team (M4-10), inside withTenant on the company
export type GetCompanyAdminsDALRequest = { companyId: string; limit: number };

// DEV_NOTE: isForUpdate locks the row (Remove admin)
export type FindCompanyAdminByClerkUserIdDALRequest = Pick<Admin, "clerkUserId"> & {
  companyId: string;
  isForUpdate?: boolean;
};

// DEV_NOTE: Matched case-insensitively (Clerk may store mixed case; invites store lowercase)
export type FindCompanyAdminByEmailDALRequest = { companyId: string; email: string };

export type DeleteAdminDALRequest = { companyId: string; adminId: Admin["id"] };
