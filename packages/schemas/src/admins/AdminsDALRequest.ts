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
