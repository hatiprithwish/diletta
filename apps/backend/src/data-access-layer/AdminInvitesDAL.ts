import { and, asc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { adminInvites, admins, companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: One Pending invite per company and email
const EMAIL_PENDING_INDEX = "UNQ_admin_invites_company_id_email_pending";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo and filters on
// companyId (on top of RLS). Emails are PII: they never go into log metadata.
export default class AdminInvitesDAL {
  async createAdminInvite(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateAdminInviteDALRequest,
  ) {
    const response: Schemas.AdminInviteDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, invitedBy: params.invitedBy };

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
          action: Schemas.LogAction.CreateAdminInvite,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      const [adminInvite] = await tx
        .insert(adminInvites)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          email: params.email,
          clerkInvitationId: params.clerkInvitationId,
          clerkUserId: params.clerkUserId,
          invitedBy: params.invitedBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Admin invite created successfully";
      response.adminInvite = adminInvite;
    } catch (error) {
      const isEmailTaken = Utility.isUniqueViolation(error, EMAIL_PENDING_INDEX);
      const message = isEmailTaken
        ? "A pending invite already exists for this email"
        : "Unknown error in creating admin invite";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateAdminInvite,
        message,
        error,
        metadata,
      });
      response.message = message;
      response.isEmailTaken = isEmailTaken;
    }

    return response;
  }

  async getAdminInviteDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetAdminInviteDetailsDALRequest,
  ) {
    const response: Schemas.AdminInviteDALResponse = { isSuccess: false };
    const { isForUpdate: _isForUpdate, ...metadata } = params;

    try {
      const conditions = [
        eq(adminInvites.publicId, params.publicId),
        eq(adminInvites.companyId, params.companyId),
      ];
      const query = tx
        .select()
        .from(adminInvites)
        .where(and(...conditions))
        .limit(1);
      const [adminInvite] = params.isForUpdate ? await query.for("update") : await query;

      if (!adminInvite) {
        response.message = "Admin invite not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin invite fetched successfully";
      response.adminInvite = adminInvite;
    } catch (error) {
      const message = "Unknown error in fetching admin invite";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetAdminInviteDetails,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: isNotFound when the email has no Pending invite in the company: the expected answer before an invite
  async findPendingAdminInviteByEmail(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindPendingAdminInviteByEmailDALRequest,
  ) {
    const response: Schemas.AdminInviteDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(adminInvites.companyId, params.companyId),
        eq(adminInvites.email, params.email),
        eq(adminInvites.status, Schemas.AdminInviteStatusIntEnum.Pending),
      ];
      const [adminInvite] = await tx
        .select()
        .from(adminInvites)
        .where(and(...conditions))
        .limit(1);

      if (!adminInvite) {
        response.message = "No pending invite for this email";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Pending admin invite fetched successfully";
      response.adminInvite = adminInvite;
    } catch (error) {
      const message = "Unknown error in fetching pending admin invite";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.FindPendingAdminInviteByEmail,
        message,
        error,
        metadata: { companyId: params.companyId },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The Team page's invites: Pending only, oldest first, with the inviting admin's name (null once removed)
  async getPendingAdminInvites(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetPendingAdminInvitesDALRequest,
  ) {
    const response: Schemas.PendingAdminInvitesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(adminInvites.companyId, params.companyId),
        eq(adminInvites.status, Schemas.AdminInviteStatusIntEnum.Pending),
      ];
      const rows = await tx
        .select({ adminInvite: adminInvites, invitedByName: admins.name })
        .from(adminInvites)
        .leftJoin(admins, eq(admins.id, adminInvites.invitedBy))
        .where(and(...conditions))
        .orderBy(asc(adminInvites.createdAt), asc(adminInvites.id))
        .limit(params.limit);

      response.isSuccess = true;
      response.message = "Pending admin invites fetched successfully";
      response.adminInvites = rows.map((row) => ({
        ...row.adminInvite,
        invitedByName: row.invitedByName,
      }));
    } catch (error) {
      const message = "Unknown error in listing pending admin invites";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPendingAdminInvites,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async setAdminInviteClerkRef(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.SetAdminInviteClerkRefDALRequest,
  ) {
    const response: Schemas.AdminInviteDALResponse = { isSuccess: false };
    const metadata = { companyId: params.companyId, publicId: params.publicId };

    try {
      const conditions = [
        eq(adminInvites.publicId, params.publicId),
        eq(adminInvites.companyId, params.companyId),
      ];
      const [adminInvite] = await tx
        .update(adminInvites)
        .set({
          clerkInvitationId: params.clerkInvitationId,
          clerkUserId: params.clerkUserId,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!adminInvite) {
        const message = "Admin invite not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SetAdminInviteClerkRef,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin invite updated successfully";
      response.adminInvite = adminInvite;
    } catch (error) {
      const message = "Unknown error in updating admin invite";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SetAdminInviteClerkRef,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Pending → Accepted (accepted_at = now) or Revoked. Matches Pending rows only, so an invite leaves Pending
  // once; no match = isNotFound.
  async updateAdminInviteStatus(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateAdminInviteStatusDALRequest,
  ) {
    const response: Schemas.AdminInviteDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const conditions = [
        eq(adminInvites.publicId, params.publicId),
        eq(adminInvites.companyId, params.companyId),
        eq(adminInvites.status, Schemas.AdminInviteStatusIntEnum.Pending),
      ];
      const [adminInvite] = await tx
        .update(adminInvites)
        .set({
          status: params.status,
          acceptedAt: params.status === Schemas.AdminInviteStatusIntEnum.Accepted ? now : undefined,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning();

      if (!adminInvite) {
        response.message = "Pending admin invite not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Admin invite updated successfully";
      response.adminInvite = adminInvite;
    } catch (error) {
      const message = "Unknown error in updating admin invite status";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateAdminInviteStatus,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}
