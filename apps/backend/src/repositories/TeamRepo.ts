import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import AdminInvitesDAL from "@/data-access-layer/AdminInvitesDAL";
import AdminsDAL from "@/data-access-layer/AdminsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import ClerkProvider from "@/providers/clerk";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

type TeamWrite = Schemas.WithOutboxIds<Schemas.TeamWriteApiResponse>;

// DEV_NOTE: Settings › Team (M4-10). Tenant Repo: one withTenant per write, with the company row locked first, so
// invites, revokes and removals in one company run one after the other (the last-admin check holds). Clerk is called
// inside that transaction after the row it refers to exists: a failed Clerk call rolls the row back (502
// ClerkUnavailable); a commit that fails after Clerk answered leaves Clerk pointing at an invite row that doesn't exist,
// which AdminsRepo.provisionAdmin refuses. Emails are PII: never logged; the audit label is the invitee's email or the
// removed admin's name.
export default class TeamRepo {
  private env: Env;
  private db: NodePgDatabase;
  private adminsDal: AdminsDAL;
  private adminInvitesDal: AdminInvitesDAL;
  private companiesDal: CompaniesDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.adminsDal = new AdminsDAL();
    this.adminInvitesDal = new AdminInvitesDAL();
    this.companiesDal = new CompaniesDAL();
  }

  private toTeamInvite(
    adminInvite: Schemas.AdminInvite,
    invitedByName: string | null,
  ): Schemas.TeamInvite {
    return {
      publicId: adminInvite.publicId,
      email: adminInvite.email,
      status: adminInvite.status,
      statusLabel: Schemas.ADMIN_INVITE_STATUS_LABEL_MAP[adminInvite.status],
      isEmailed: adminInvite.clerkUserId === null,
      invitedByName,
      createdAt: adminInvite.createdAt.toISOString(),
    };
  }

  private refused(failure: Schemas.TeamFailureEnum, message: string): TeamWrite {
    return { isSuccess: false, message, failure, outboxIds: [] };
  }

  // DEV_NOTE: The company's admins and Pending invites. Last active comes from Clerk outside the transaction; if Clerk
  // can't be read the page still loads, with isLastActiveKnown false.
  async getTeam(params: {
    companyId: string;
    adminId: string;
  }): Promise<Schemas.GetTeamApiResponse> {
    const read = await withTenant(
      this.db,
      params.companyId,
      async (
        tx,
      ): Promise<
        Schemas.ApiResponse & {
          admins?: Schemas.Admin[];
          invites?: Schemas.PendingAdminInvitesDALResponse["adminInvites"];
        }
      > => {
        const listed = await this.adminsDal.getCompanyAdmins(tx, {
          companyId: params.companyId,
          limit: Schemas.TEAM_ADMINS_MAX,
        });
        if (!listed.isSuccess || !listed.admins)
          return { isSuccess: false, message: listed.message };
        const invited = await this.adminInvitesDal.getPendingAdminInvites(tx, {
          companyId: params.companyId,
          limit: Schemas.TEAM_PENDING_INVITES_MAX,
        });
        if (!invited.isSuccess || !invited.adminInvites) {
          return { isSuccess: false, message: invited.message };
        }
        return { isSuccess: true, admins: listed.admins, invites: invited.adminInvites };
      },
    );
    if (!read.isSuccess || !("admins" in read) || !read.admins || !read.invites) {
      return { isSuccess: false, message: read.message };
    }

    const lastActive = await ClerkProvider.getLastActive(
      this.env,
      read.admins.map((admin) => admin.clerkUserId),
    );
    const lastActiveAt = lastActive.lastActiveAt ?? {};
    return {
      isSuccess: true,
      message: "Team fetched successfully",
      team: {
        members: read.admins.map((admin) => {
          const activeAt = lastActiveAt[admin.clerkUserId];
          return {
            clerkUserId: admin.clerkUserId,
            name: admin.name,
            email: admin.email,
            isYou: admin.id === params.adminId,
            lastActiveAt: typeof activeAt === "number" ? new Date(activeAt).toISOString() : null,
            createdAt: admin.createdAt.toISOString(),
          };
        }),
        invites: read.invites.map(({ invitedByName, ...invite }) =>
          this.toTeamInvite(invite, invitedByName),
        ),
        isLastActiveKnown: lastActive.isSuccess,
      },
    };
  }

  // DEV_NOTE: Invite an admin by email. A new email gets an emailed Clerk invitation; an existing Clerk account that
  // administers no company gets the invite metadata directly (no email: the page says so); an admin of any company, an
  // admin of this one by email, or an email already invited here is 409. The account lookup (Clerk, then the admins
  // row in withPlatform: the Clerk user → any company lookup, rule 3.15) runs before the transaction.
  async inviteAdmin(
    params: Schemas.CreateAdminInviteApiRequest & { companyId: string; adminId: string },
  ): Promise<TeamWrite> {
    const account = await ClerkProvider.findUserByEmail(this.env, params.email);
    if (!account.isSuccess) {
      return this.refused(
        Schemas.TeamFailureEnum.ClerkUnavailable,
        account.message ?? "Clerk unavailable",
      );
    }
    const existingClerkUserId = account.clerkUserId ?? null;
    if (existingClerkUserId) {
      const existing: Schemas.AdminDALResponse = await withPlatform(
        this.db,
        async (tx) =>
          await this.adminsDal.getAdminByClerkUserId(tx, { clerkUserId: existingClerkUserId }),
      );
      if (existing.isSuccess) {
        return this.refused(
          Schemas.TeamFailureEnum.AlreadyAdmin,
          "This person is already an admin",
        );
      }
      if (!existing.isNotFound)
        return { isSuccess: false, message: existing.message, outboxIds: [] };
    }

    let failure: Schemas.TeamFailureEnum | undefined;
    const result: TeamWrite = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<TeamWrite> => {
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
          isForUpdate: true,
        });
        if (!company.isSuccess || !company.company) {
          return { isSuccess: false, message: company.message, outboxIds: [] };
        }

        const admin = await this.adminsDal.getCompanyAdminByEmail(tx, {
          companyId: params.companyId,
          email: params.email,
        });
        if (admin.isSuccess) {
          return this.refused(
            Schemas.TeamFailureEnum.AlreadyAdmin,
            "This person is already an admin",
          );
        }
        if (!admin.isNotFound) return { isSuccess: false, message: admin.message, outboxIds: [] };
        const pending = await this.adminInvitesDal.findPendingAdminInviteByEmail(tx, {
          companyId: params.companyId,
          email: params.email,
        });
        if (pending.isSuccess) {
          return this.refused(
            Schemas.TeamFailureEnum.AlreadyInvited,
            "This email already has an invite",
          );
        }
        if (!pending.isNotFound)
          return { isSuccess: false, message: pending.message, outboxIds: [] };

        const created = await this.adminInvitesDal.createAdminInvite(tx, {
          companyId: params.companyId,
          email: params.email,
          clerkInvitationId: null,
          clerkUserId: null,
          invitedBy: params.adminId,
        });
        if (!created.isSuccess || !created.adminInvite) {
          if (created.isEmailTaken) failure = Schemas.TeamFailureEnum.AlreadyInvited;
          throw new TenantRollbackError(created.message ?? "Invite not created");
        }
        const inviteRef = {
          companyPublicId: company.company.publicId,
          adminInvitePublicId: created.adminInvite.publicId,
        };

        let clerkInvitationId: string | null = null;
        if (existingClerkUserId) {
          const granted = await ClerkProvider.grantInvite(this.env, {
            ...inviteRef,
            clerkUserId: existingClerkUserId,
          });
          if (!granted.isSuccess) {
            failure = Schemas.TeamFailureEnum.ClerkUnavailable;
            throw new TenantRollbackError(granted.message ?? "Clerk unavailable");
          }
        } else {
          const invitation = await ClerkProvider.createInvitation(this.env, {
            ...inviteRef,
            email: params.email,
          });
          if (!invitation.isSuccess || !invitation.invitationId) {
            failure = Schemas.TeamFailureEnum.ClerkUnavailable;
            throw new TenantRollbackError(invitation.message ?? "Clerk unavailable");
          }
          clerkInvitationId = invitation.invitationId;
        }

        const updated = await this.adminInvitesDal.setAdminInviteClerkRef(tx, {
          companyId: params.companyId,
          publicId: created.adminInvite.publicId,
          clerkInvitationId,
          clerkUserId: existingClerkUserId,
        });
        if (!updated.isSuccess || !updated.adminInvite) {
          throw new TenantRollbackError(updated.message ?? "Invite not saved");
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.AdminInvite,
          entityAction: Schemas.AuditEntityActionEnum.Created,
          entity: updated.adminInvite,
          label: params.email,
        });
        return {
          isSuccess: true,
          message: "Admin invited successfully",
          invite: this.toTeamInvite(updated.adminInvite, null),
          outboxIds: [outboxId],
        };
      },
    );
    return failure && !result.isSuccess ? { ...result, failure, outboxIds: [] } : result;
  }

  // DEV_NOTE: Revoke a Pending invite: the row locked, Clerk told (the invitation revoked, or a granted account's
  // metadata cleared), the row Revoked, its audit row. Only from Pending (else 409 NotPending, nothing written).
  async revokeInvite(params: {
    companyId: string;
    adminId: string;
    publicId: string;
  }): Promise<TeamWrite> {
    let failure: Schemas.TeamFailureEnum | undefined;
    const result: TeamWrite = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<TeamWrite> => {
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
          isForUpdate: true,
        });
        if (!company.isSuccess)
          return { isSuccess: false, message: company.message, outboxIds: [] };

        const found = await this.adminInvitesDal.getAdminInviteDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.adminInvite) {
          return {
            isSuccess: false,
            message: found.message,
            isNotFound: found.isNotFound,
            outboxIds: [],
          };
        }
        if (found.adminInvite.status !== Schemas.AdminInviteStatusIntEnum.Pending) {
          return this.refused(Schemas.TeamFailureEnum.NotPending, "This invite isn't pending");
        }

        const revoked = await ClerkProvider.revokeInvite(this.env, {
          clerkInvitationId: found.adminInvite.clerkInvitationId,
          clerkUserId: found.adminInvite.clerkUserId,
          adminInvitePublicId: found.adminInvite.publicId,
        });
        if (!revoked.isSuccess) {
          failure = Schemas.TeamFailureEnum.ClerkUnavailable;
          throw new TenantRollbackError(revoked.message ?? "Clerk unavailable");
        }

        const updated = await this.adminInvitesDal.updateAdminInviteStatus(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          status: Schemas.AdminInviteStatusIntEnum.Revoked,
        });
        if (!updated.isSuccess || !updated.adminInvite) {
          throw new TenantRollbackError(updated.message ?? "Invite not revoked");
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.AdminInvite,
          entityAction: Schemas.AuditEntityActionEnum.Revoked,
          entity: updated.adminInvite,
          label: updated.adminInvite.email,
        });
        return {
          isSuccess: true,
          message: "Invite revoked successfully",
          invite: this.toTeamInvite(updated.adminInvite, null),
          outboxIds: [outboxId],
        };
      },
    );
    return failure && !result.isSuccess ? { ...result, failure, outboxIds: [] } : result;
  }

  // DEV_NOTE: Remove a company admin (by Clerk user id). Never yourself (409 CannotRemoveSelf) and never the company's
  // last admin (409 LastAdmin), counted under the company row's lock. The audit row's entity is the removed admins row
  // (its client-facing id is the Clerk user id), labelled with their name, else email.
  async removeAdmin(params: {
    companyId: string;
    adminId: string;
    clerkUserId: string;
  }): Promise<TeamWrite> {
    return await withTenant(this.db, params.companyId, async (tx): Promise<TeamWrite> => {
      const company = await this.companiesDal.getCompanyDetails(tx, {
        companyId: params.companyId,
        isForUpdate: true,
      });
      if (!company.isSuccess) return { isSuccess: false, message: company.message, outboxIds: [] };

      const found = await this.adminsDal.getCompanyAdminByClerkUserId(tx, {
        companyId: params.companyId,
        clerkUserId: params.clerkUserId,
        isForUpdate: true,
      });
      if (!found.isSuccess || !found.admin) {
        return {
          isSuccess: false,
          message: found.message,
          isNotFound: found.isNotFound,
          outboxIds: [],
        };
      }
      if (found.admin.id === params.adminId) {
        return this.refused(Schemas.TeamFailureEnum.CannotRemoveSelf, "You can't remove yourself");
      }
      const listed = await this.adminsDal.getCompanyAdmins(tx, {
        companyId: params.companyId,
        limit: 2,
      });
      if (!listed.isSuccess || !listed.admins) {
        return { isSuccess: false, message: listed.message, outboxIds: [] };
      }
      if (listed.admins.length < 2) {
        return this.refused(Schemas.TeamFailureEnum.LastAdmin, "The last admin can't be removed");
      }

      const removed = await this.adminsDal.deleteAdmin(tx, {
        companyId: params.companyId,
        adminId: found.admin.id,
      });
      if (!removed.isSuccess || !removed.admin) {
        throw new TenantRollbackError(removed.message ?? "Admin not removed");
      }

      const outboxId = await recordAuditOrRollback(tx, {
        companyId: params.companyId,
        actor: adminAuditActor(params.adminId),
        entityType: Schemas.AuditEntityTypeEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Removed,
        entity: { id: removed.admin.id, publicId: removed.admin.clerkUserId },
        label: removed.admin.name ?? removed.admin.email ?? "An admin",
      });
      return { isSuccess: true, message: "Admin removed successfully", outboxIds: [outboxId] };
    });
  }
}
