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

// DEV_NOTE: Settings › Team (M4-10). Tenant Repo: each write's checks run in a withTenant with the company row locked,
// so invites, revokes and removals in one company run one after the other (the last-admin check holds). Clerk is never
// called inside a transaction (no lock or pooled connection held across it): an invite commits its Pending row first,
// then calls Clerk, then records the Clerk reference and its audit row; a revoke commits Revoked first, then tells Clerk.
// The row decides access (AdminsRepo.provisionAdmin), so Clerk metadata always points at a committed row. Emails are
// PII: never logged; the audit label is the invitee's email or the removed admin's name.
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

  // DEV_NOTE: Invite an admin by email. Refused (409): an account that administers any company, or already carries
  // another invite's metadata (HasPendingInvite: granting would silently replace it); an admin of this company by email
  // (any case); a Pending invite for the email here. Otherwise:
  // 1. the Pending row is committed (company row locked, clerk refs null; unused until Clerk points at it);
  // 2. Clerk: an emailed invitation for a new email, or the invite metadata on the existing account (no email);
  // 3. the Clerk reference and the Invited audit row, in one withTenant.
  // A Clerk failure marks the row Revoked (nothing points at it) and answers 502; a failure at 3 revokes it on Clerk and
  // the row too, best effort, and answers 500.
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
      if (account.hasPendingInvite) {
        return this.refused(
          Schemas.TeamFailureEnum.HasPendingInvite,
          "This person already has a pending invite",
        );
      }
    }

    // 1. The Pending row
    let company: Schemas.Company | undefined;
    const created: TeamWrite & { adminInvite?: Schemas.AdminInvite } = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<TeamWrite & { adminInvite?: Schemas.AdminInvite }> => {
        const locked = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
          isForUpdate: true,
        });
        if (!locked.isSuccess || !locked.company) {
          return { isSuccess: false, message: locked.message, outboxIds: [] };
        }
        company = locked.company;

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

        const inserted = await this.adminInvitesDal.createAdminInvite(tx, {
          companyId: params.companyId,
          email: params.email,
          clerkInvitationId: null,
          clerkUserId: null,
          invitedBy: params.adminId,
        });
        if (!inserted.isSuccess || !inserted.adminInvite) {
          return inserted.isEmailTaken
            ? this.refused(
                Schemas.TeamFailureEnum.AlreadyInvited,
                "This email already has an invite",
              )
            : { isSuccess: false, message: inserted.message, outboxIds: [] };
        }
        return { isSuccess: true, adminInvite: inserted.adminInvite, outboxIds: [] };
      },
    );
    if (!created.isSuccess || !created.adminInvite || !company) return created;
    const invite = created.adminInvite;
    const inviteRef = { companyPublicId: company.publicId, adminInvitePublicId: invite.publicId };

    // 2. Clerk, outside any transaction
    let clerkInvitationId: string | null = null;
    const sent = existingClerkUserId
      ? await ClerkProvider.grantInvite(this.env, {
          ...inviteRef,
          clerkUserId: existingClerkUserId,
        })
      : await ClerkProvider.createInvitation(this.env, { ...inviteRef, email: params.email });
    if ("invitationId" in sent) clerkInvitationId = sent.invitationId ?? null;
    if (!sent.isSuccess || (!existingClerkUserId && !clerkInvitationId)) {
      await this.closeUnsentInvite(params.companyId, invite.publicId);
      return this.refused(
        Schemas.TeamFailureEnum.ClerkUnavailable,
        sent.message ?? "Clerk unavailable",
      );
    }

    // 3. The Clerk reference and the audit row
    const recorded: TeamWrite = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<TeamWrite> => {
        const updated = await this.adminInvitesDal.setAdminInviteClerkRef(tx, {
          companyId: params.companyId,
          publicId: invite.publicId,
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
    if (!recorded.isSuccess) {
      await ClerkProvider.revokeInvite(this.env, {
        clerkInvitationId,
        clerkUserId: existingClerkUserId,
        adminInvitePublicId: invite.publicId,
      });
      await this.closeUnsentInvite(params.companyId, invite.publicId);
      return { ...recorded, outboxIds: [] };
    }
    return recorded;
  }

  // DEV_NOTE: An invite whose Clerk step failed: Revoked, so it isn't listed or honoured and the email can be invited
  // again. Best effort (a failure is logged by the DAL); no audit row, since nothing was sent.
  private async closeUnsentInvite(companyId: string, publicId: string): Promise<void> {
    await withTenant(
      this.db,
      companyId,
      async (tx) =>
        await this.adminInvitesDal.updateAdminInviteStatus(tx, {
          companyId,
          publicId,
          status: Schemas.AdminInviteStatusIntEnum.Revoked,
        }),
    );
  }

  // DEV_NOTE: Revoke a Pending invite (else 409 NotPending, nothing written): Revoked with its audit row, committed under
  // the company and invite locks; then Clerk is told, best effort (ClerkProvider.revokeInvite skips an invitation that
  // isn't pending any more). The row already refuses a sign-in, so a Clerk failure is logged, not answered.
  async revokeInvite(params: {
    companyId: string;
    adminId: string;
    publicId: string;
  }): Promise<TeamWrite> {
    const result: TeamWrite & { adminInvite?: Schemas.AdminInvite } = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<TeamWrite & { adminInvite?: Schemas.AdminInvite }> => {
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
          adminInvite: updated.adminInvite,
          outboxIds: [outboxId],
        };
      },
    );
    if (!result.isSuccess || !result.adminInvite) return result;

    await ClerkProvider.revokeInvite(this.env, {
      clerkInvitationId: result.adminInvite.clerkInvitationId,
      clerkUserId: result.adminInvite.clerkUserId,
      adminInvitePublicId: result.adminInvite.publicId,
    });
    const { adminInvite: _adminInvite, ...answer } = result;
    return answer;
  }

  // DEV_NOTE: Remove a company admin (by Clerk user id). Never yourself (409 CannotRemoveSelf) and never the company's
  // last admin (409 LastAdmin), counted under the company row's lock. The row is kept (AdminsDAL.removeAdmin) so their
  // name stays on what they did; the audit row's entity is that row, labelled with their name, else email.
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

      const removed = await this.adminsDal.removeAdmin(tx, {
        companyId: params.companyId,
        adminId: found.admin.id,
        removedBy: params.adminId,
      });
      if (!removed.isSuccess || !removed.admin) {
        throw new TenantRollbackError(removed.message ?? "Admin not removed");
      }

      const outboxId = await recordAuditOrRollback(tx, {
        companyId: params.companyId,
        actor: adminAuditActor(params.adminId),
        entityType: Schemas.AuditEntityTypeEnum.Admin,
        entityAction: Schemas.AuditEntityActionEnum.Removed,
        entity: { id: found.admin.id, publicId: found.admin.clerkUserId },
        label: found.admin.name ?? found.admin.email ?? "An admin",
      });
      return { isSuccess: true, message: "Admin removed successfully", outboxIds: [outboxId] };
    });
  }
}
