import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import AdminsDAL from "@/data-access-layer/AdminsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import ClerkProvider from "@/providers/clerk";
import * as Schemas from "@app/schemas";

const NO_ACCESS_MESSAGE = "No dashboard access";

// DEV_NOTE: Dashboard identity. The Clerk admin → company lookup runs in withPlatform (no company is known yet,
// pattern rule 3.15) and reads only the admins row; anything about the admin's company runs in withTenant on it.
// Role is derived from admins.company_id: NULL = operator, set = company admin. Operators are never created here
// (runbook: docs/runbooks/operators.md); a company admin is created on first sign-in from the Clerk invite.
export default class AdminsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: AdminsDAL;
  private companiesDal: CompaniesDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new AdminsDAL();
    this.companiesDal = new CompaniesDAL();
  }

  private toContext(admin: Schemas.Admin): Schemas.AdminContext {
    return {
      adminId: admin.id,
      companyId: admin.companyId,
      role:
        admin.companyId === null
          ? Schemas.AdminRoleEnum.Operator
          : Schemas.AdminRoleEnum.CompanyAdmin,
    };
  }

  private toProfile(
    admin: Schemas.Admin,
    company: Schemas.Company | undefined,
  ): Schemas.AdminProfile {
    const { id: _id, companyId: _companyId, ...rest } = admin;
    return {
      ...rest,
      role: this.toContext(admin).role,
      company: company ? { publicId: company.publicId, name: company.name } : null,
    };
  }

  private async findAdmin(clerkUserId: string): Promise<Schemas.AdminDALResponse> {
    return await withPlatform(this.db, async (tx) => {
      return await this.dal.getAdminByClerkUserId(tx, { clerkUserId });
    });
  }

  // DEV_NOTE: Server-side only — the auth middleware's view of the signed-in admin. isSuccess with no admin means
  // the Clerk user has no admins row (403); this never provisions, so only GET /dashboard/me creates admins.
  async getAdminContext(params: { clerkUserId: string }): Promise<Schemas.GetAdminContextResponse> {
    const { admin, ...rest } = await this.findAdmin(params.clerkUserId);
    return { ...rest, admin: admin ? this.toContext(admin) : undefined };
  }

  // DEV_NOTE: The signed-in admin's profile. On first sign-in there is no row yet: the admin is created from the
  // Clerk invite's companyPublicId. No row and no invite = isSuccess with no admin (403), never an operator.
  async getMe(params: { clerkUserId: string }): Promise<Schemas.GetMeApiResponse> {
    const found = await this.findAdmin(params.clerkUserId);
    if (!found.isSuccess) {
      return { isSuccess: false, message: found.message };
    }

    if (found.admin) {
      if (found.admin.companyId === null) {
        return { isSuccess: true, admin: this.toProfile(found.admin, undefined) };
      }

      const companyId = found.admin.companyId;
      const company: Schemas.CompanyDALResponse = await withTenant(
        this.db,
        companyId,
        async (tx) => {
          return await this.companiesDal.getCompanyDetails(tx, { companyId });
        },
      );
      if (!company.isSuccess || !company.company) {
        return { isSuccess: false, message: company.message };
      }
      return { isSuccess: true, admin: this.toProfile(found.admin, company.company) };
    }

    return await this.provisionAdmin(params.clerkUserId);
  }

  private async provisionAdmin(clerkUserId: string): Promise<Schemas.GetMeApiResponse> {
    const clerkProfile = await ClerkProvider.getAdminProfile(this.env, clerkUserId);
    if (!clerkProfile.isSuccess || !clerkProfile.profile) {
      return { isSuccess: false, message: clerkProfile.message };
    }

    const { companyPublicId, email, name } = clerkProfile.profile;
    if (!companyPublicId) {
      return { isSuccess: true, message: NO_ACCESS_MESSAGE };
    }

    const invitedCompany: Schemas.CompanyDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.companiesDal.getCompanyByPublicId(tx, { publicId: companyPublicId });
    });
    if (!invitedCompany.isSuccess) {
      return { isSuccess: false, message: invitedCompany.message };
    }
    if (!invitedCompany.company) {
      return { isSuccess: true, message: NO_ACCESS_MESSAGE };
    }

    const company = invitedCompany.company;
    const created: Schemas.AdminDALResponse = await withTenant(this.db, company.id, async (tx) => {
      return await this.dal.createAdmin(tx, {
        clerkUserId,
        companyId: company.id,
        email,
        name,
      });
    });
    if (!created.isSuccess || !created.admin) {
      return { isSuccess: false, message: created.message };
    }

    return { isSuccess: true, admin: this.toProfile(created.admin, company) };
  }
}
