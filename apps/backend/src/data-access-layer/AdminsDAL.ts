import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { admins, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Tenant DAL — holds no db client. getAdminByClerkUserId is the Clerk admin → company lookup: the Repo
// runs it in withPlatform before any company is known, so it filters on clerk_user_id alone (pattern rule 3.15).
// createAdmin runs in withTenant on the admin's company and sets companyId from params.
export default class AdminsDAL {
  // DEV_NOTE: A lookup — no row is a normal answer (isSuccess, no admin), so the caller can tell
  // "not an admin" (403) from a failed query (500).
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

      response.isSuccess = true;
      response.message = admin ? "Admin fetched successfully" : "Admin not found";
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
}
