import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { admins, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. getAdminByClerkUserId is the Clerk admin → company lookup: the Repo
// runs it in withPlatform before any company is known, so it filters on clerk_user_id alone (pattern rule 3.15).
// createAdmin runs in withTenant on the admin's company and sets companyId from params. An unknown Clerk user is
// not an error worth logging (any signed-in Clerk user can ask), so the not-found path doesn't log.
export default class AdminsDAL {
  async getAdminByClerkUserId(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindAdminByClerkUserIdDALRequest,
  ) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };

    try {
      const [admin] = await tx
        .select()
        .from(admins)
        .where(eq(admins.clerkUserId, params.clerkUserId))
        .limit(1);

      if (!admin) {
        response.message = "Admin not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin fetched successfully";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in fetching admin";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetAdminByClerkUserId,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: ON CONFLICT DO NOTHING, then re-read: two first sign-ins racing on the same Clerk user both end
  // with the one row, and the transaction is never aborted by a unique violation. A conflicting row in another
  // company (or an operator's) re-reads as nothing and fails. email and name stay out of the logs (PII).
  async createAdmin(tx: NodePgTransaction<EmptyRelations>, params: Schemas.CreateAdminDALRequest) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateAdmin,
          message,
          metadata: { clerkUserId: params.clerkUserId, companyId: params.companyId },
        });
        response.message = message;
        return response;
      }

      const [inserted] = await tx
        .insert(admins)
        .values({
          clerkUserId: params.clerkUserId,
          companyId: params.companyId,
          email: params.email,
          name: params.name,
        })
        .onConflictDoNothing({ target: admins.clerkUserId })
        .returning();

      const conditions = [
        eq(admins.clerkUserId, params.clerkUserId),
        eq(admins.companyId, params.companyId),
      ];
      const [admin] = inserted
        ? [inserted]
        : await tx
            .select()
            .from(admins)
            .where(and(...conditions))
            .limit(1);

      if (!admin) {
        const message = "Admin already exists for another company";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateAdmin,
          message,
          metadata: { clerkUserId: params.clerkUserId, companyId: params.companyId },
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = inserted ? "Admin created successfully" : "Admin already exists";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in creating admin";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateAdmin,
        message,
        error,
        metadata: { clerkUserId: params.clerkUserId, companyId: params.companyId },
      });
      response.message = message;
    }

    return response;
  }

  async updateAdminEmail(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateAdminEmailDALRequest,
  ) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: An operator's row has no company, so it is matched with IS NULL (in withPlatform)
      const conditions = [
        eq(admins.id, params.adminId),
        params.companyId === null
          ? isNull(admins.companyId)
          : eq(admins.companyId, params.companyId),
      ];
      const [admin] = await tx
        .update(admins)
        .set({ email: params.email, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();

      if (!admin) {
        const message = "Admin not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateAdminEmail,
          message,
          metadata: { adminId: params.adminId, companyId: params.companyId },
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin email updated successfully";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in updating admin email";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateAdminEmail,
        message,
        error,
        metadata: { adminId: params.adminId, companyId: params.companyId },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A company admin by internal id, inside withTenant on their company. Not found is not logged: the admin
  // may have been removed since (an actor column keeps the id).
  async getAdminDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindAdminDALRequest,
  ) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(admins.id, params.adminId), eq(admins.companyId, params.companyId)];
      const [admin] = await tx
        .select()
        .from(admins)
        .where(and(...conditions))
        .limit(1);

      if (!admin) {
        response.message = "Admin not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin fetched successfully";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in fetching admin";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetAdminDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Settings › Team (M4-10): the company's admins, oldest first
  async getCompanyAdmins(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompanyAdminsDALRequest,
  ) {
    const response: Schemas.AdminsDALResponse = { isSuccess: false };

    try {
      const rows = await tx
        .select()
        .from(admins)
        .where(eq(admins.companyId, params.companyId))
        .orderBy(asc(admins.createdAt), asc(admins.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Company admins fetched successfully";
      response.admins = rows;
    } catch (error) {
      const message = "Unknown error in listing company admins";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyAdmins,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: A company admin by Clerk user id (Remove admin), locked when isForUpdate
  async getCompanyAdminByClerkUserId(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindCompanyAdminByClerkUserIdDALRequest,
  ) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };
    const { isForUpdate: _isForUpdate, ...metadata } = params;

    try {
      const conditions = [
        eq(admins.clerkUserId, params.clerkUserId),
        eq(admins.companyId, params.companyId),
      ];
      const query = tx
        .select()
        .from(admins)
        .where(and(...conditions))
        .limit(1);
      const [admin] = params.isForUpdate ? await query.for("update") : await query;

      if (!admin) {
        response.message = "Admin not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin fetched successfully";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in fetching company admin";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyAdminByClerkUserId,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Is this email already an admin of the company (Invite)? Case-insensitive; isNotFound = no. The email stays
  // out of the logs (PII).
  async getCompanyAdminByEmail(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindCompanyAdminByEmailDALRequest,
  ) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(admins.companyId, params.companyId),
        eq(sql`lower(${admins.email})`, params.email.toLowerCase()),
      ];
      const [admin] = await tx
        .select()
        .from(admins)
        .where(and(...conditions))
        .limit(1);

      if (!admin) {
        response.message = "No admin with this email";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin fetched successfully";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in fetching company admin by email";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyAdminByEmail,
        message,
        error,
        metadata: { companyId: params.companyId },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Remove admin (M4-10). Their next request gets 403: the auth middleware reads the row on every request, and
  // the invite that created it was consumed, so /dashboard/me can't recreate it.
  async deleteAdmin(tx: NodePgTransaction<EmptyRelations>, params: Schemas.DeleteAdminDALRequest) {
    const response: Schemas.AdminDALResponse = { isSuccess: false };

    try {
      const conditions = [eq(admins.id, params.adminId), eq(admins.companyId, params.companyId)];
      const [admin] = await tx
        .delete(admins)
        .where(and(...conditions))
        .returning();

      if (!admin) {
        response.message = "Admin not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin removed successfully";
      response.admin = admin;
    } catch (error) {
      const message = "Unknown error in removing admin";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.DeleteAdmin,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
