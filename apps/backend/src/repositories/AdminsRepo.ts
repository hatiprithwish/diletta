import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import AdminsDAL from "@/data-access-layer/AdminsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ClerkProvider from "@/providers/clerk";
import * as Schemas from "@app/schemas";

const NO_ACCESS_MESSAGE = "No dashboard access";
const CHURNED_MESSAGE = "Company has churned";

// DEV_NOTE: Dashboard identity. The Clerk admin → company lookup runs in withPlatform (no company is known yet,
// pattern rule 3.15) and reads only the admins row; anything about the admin's company runs in withTenant on it.
// Role is derived from admins.company_id in toContext only: NULL = operator, set = company admin. Operators are
// never created here (runbook: docs/runbooks/operators.md); a company admin is created on first sign-in from the
// Clerk invite, which is then consumed. A churned company's admins have no access; operators are unaffected.
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
    return admin.companyId === null
      ? { adminId: admin.id, role: Schemas.AdminRoleEnum.Operator, companyId: null }
      : { adminId: admin.id, role: Schemas.AdminRoleEnum.CompanyAdmin, companyId: admin.companyId };
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

  // DEV_NOTE: isNotFound = no admins row (getMe may provision). isSuccess with no admin = no access: the company
  // has churned, or no longer exists.
  private async resolveAdmin(clerkUserId: string): Promise<Schemas.ResolvedAdminResponse> {
    const found: Schemas.AdminDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.dal.getAdminByClerkUserId(tx, { clerkUserId });
    });
    if (!found.isSuccess || !found.admin) {
      return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
    }

    const context = this.toContext(found.admin);
    if (context.role === Schemas.AdminRoleEnum.Operator) {
      return { isSuccess: true, admin: found.admin };
    }

    const companyId = context.companyId;
    const company: Schemas.CompanyDALResponse = await withTenant(this.db, companyId, async (tx) => {
      return await this.companiesDal.getCompanyDetails(tx, { companyId });
    });
    if (!company.isSuccess || !company.company) {
      return company.isNotFound
        ? { isSuccess: true, message: NO_ACCESS_MESSAGE }
        : { isSuccess: false, message: company.message };
    }
    if (company.company.status === Schemas.CompanyStatusIntEnum.Churned) {
      return { isSuccess: true, message: CHURNED_MESSAGE };
    }

    return { isSuccess: true, admin: found.admin, company: company.company };
  }

  // DEV_NOTE: Server-side only — the auth middleware's view of the signed-in admin. isSuccess with no admin means
  // no access (no admins row, or a churned company): 403. Never provisions; only GET /dashboard/me creates admins.
  async getAdminContext(params: { clerkUserId: string }): Promise<Schemas.GetAdminContextResponse> {
    const resolved = await this.resolveAdmin(params.clerkUserId);
    if (!resolved.isSuccess) {
      // DEV_NOTE: No admins row is an answer (403), not a failure (500)
      return resolved.isNotFound
        ? { isSuccess: true, message: resolved.message }
        : { isSuccess: false, message: resolved.message };
    }
    return {
      isSuccess: true,
      message: resolved.message,
      admin: resolved.admin ? this.toContext(resolved.admin) : undefined,
    };
  }

  // DEV_NOTE: The signed-in admin's profile. On first sign-in there is no row yet: the admin is created from the
  // Clerk invite's companyPublicId. No row and no invite = isSuccess with no admin (403), never an operator.
  // sessionEmail (from the Clerk session claims, may be empty) keeps admins.email current.
  async getMe(params: {
    clerkUserId: string;
    sessionEmail: string;
  }): Promise<Schemas.GetMeApiResponse> {
    const resolved = await this.resolveAdmin(params.clerkUserId);
    if (!resolved.isSuccess) {
      return resolved.isNotFound
        ? await this.provisionAdmin(params.clerkUserId)
        : { isSuccess: false, message: resolved.message };
    }
    if (!resolved.admin) {
      return { isSuccess: true, message: resolved.message };
    }

    const admin = await this.syncEmail(resolved.admin, params.sessionEmail);
    return { isSuccess: true, admin: this.toProfile(admin, resolved.company) };
  }

  // DEV_NOTE: Best effort — a failed update is logged by the DAL and the profile keeps the stored email. An
  // operator's row has no company, so it is updated in withPlatform; a company admin's in withTenant on it.
  private async syncEmail(admin: Schemas.Admin, sessionEmail: string): Promise<Schemas.Admin> {
    if (!sessionEmail || sessionEmail === admin.email) {
      return admin;
    }

    const context = this.toContext(admin);
    const params = { adminId: admin.id, companyId: context.companyId, email: sessionEmail };
    const updated: Schemas.AdminDALResponse =
      context.role === Schemas.AdminRoleEnum.Operator
        ? await withPlatform(this.db, async (tx) => await this.dal.updateAdminEmail(tx, params))
        : await withTenant(
            this.db,
            context.companyId,
            async (tx) => await this.dal.updateAdminEmail(tx, params),
          );
    return updated.isSuccess && updated.admin ? updated.admin : admin;
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
    if (!invitedCompany.isSuccess || !invitedCompany.company) {
      return invitedCompany.isNotFound
        ? { isSuccess: true, message: NO_ACCESS_MESSAGE }
        : { isSuccess: false, message: invitedCompany.message };
    }
    if (invitedCompany.company.status === Schemas.CompanyStatusIntEnum.Churned) {
      return { isSuccess: true, message: CHURNED_MESSAGE };
    }

    // DEV_NOTE: Transactional flow — the invite is consumed before the admin row commits, so a failed Clerk call
    // rolls the row back (the user retries on the next load). Without this, deleting the row later would not
    // revoke access: the next /dashboard/me would re-provision from the same metadata.
    const company = invitedCompany.company;
    const created: Schemas.AdminDALResponse = await withTenant(this.db, company.id, async (tx) => {
      const result = await this.dal.createAdmin(tx, {
        clerkUserId,
        companyId: company.id,
        email,
        name,
      });
      if (!result.isSuccess) {
        return result;
      }

      const consumed = await ClerkProvider.consumeInvite(this.env, clerkUserId);
      if (!consumed.isSuccess) {
        throw new TenantRollbackError(consumed.message);
      }
      return result;
    });
    if (!created.isSuccess || !created.admin) {
      return { isSuccess: false, message: created.message };
    }

    return { isSuccess: true, admin: this.toProfile(created.admin, company) };
  }
}
