import z from "zod";

// DEV_NOTE: Derived from admins.company_id, never stored: NULL = operator, set = company admin.
// There is no role column, so this is a string enum for API responses and can(), not a Status Enum.
export enum AdminRoleEnum {
  Operator = "operator",
  CompanyAdmin = "companyAdmin",
}

// Whole Admin Body — DB shape
// DEV_NOTE: id and companyId are internal bigint ids — used by DAL/Repo only, NEVER sent to a client.
// clerkUserId is the client-facing id (admins carry no publicId).
export const ZAdmin = z.object({
  id: z.string(),
  clerkUserId: z.string(),
  companyId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Admin = z.infer<typeof ZAdmin>;

// DEV_NOTE: Server-side only — the signed-in admin as the auth middleware sees it, and the subject of can().
// Carries internal ids, so it never goes into an API response. A union on role, so checking the role also
// narrows companyId (operator: null, company admin: string) and a company admin without a company can't exist.
export type AdminContext =
  | { adminId: Admin["id"]; role: AdminRoleEnum.Operator; companyId: null }
  | { adminId: Admin["id"]; role: AdminRoleEnum.CompanyAdmin; companyId: string };

// API response shape — internal ids structurally omitted; the company is identified by its publicId
export type AdminProfile = Omit<Admin, "id" | "companyId"> & {
  role: AdminRoleEnum;
  company: { publicId: string; name: string } | null;
};

// DEV_NOTE: What the dashboard needs from a Clerk user to provision an admin. companyPublicId comes from the
// invite's publicMetadata (Settings › Team, M4-10); null = not invited to any company.
export interface ClerkAdminProfile {
  email: string | null;
  name: string | null;
  companyPublicId: string | null;
}
