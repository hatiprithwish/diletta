import type { AdminInvite } from "./AdminInvitesCommon";

export type CreateAdminInviteDALRequest = Pick<
  AdminInvite,
  "companyId" | "email" | "clerkInvitationId" | "clerkUserId" | "invitedBy"
>;

export type FindAdminInviteDALRequest = Pick<AdminInvite, "companyId" | "publicId">;

// DEV_NOTE: isForUpdate locks the row (revoke, accept), so a revoke and a first sign-in run one after the other
export type GetAdminInviteDetailsDALRequest = FindAdminInviteDALRequest & { isForUpdate?: boolean };

export type FindPendingAdminInviteByEmailDALRequest = Pick<AdminInvite, "companyId" | "email">;

export type GetPendingAdminInvitesDALRequest = Pick<AdminInvite, "companyId"> & { limit: number };

// DEV_NOTE: The Clerk side of an invite, set once Clerk has answered (in the same transaction as the insert)
export type SetAdminInviteClerkRefDALRequest = FindAdminInviteDALRequest &
  Pick<AdminInvite, "clerkInvitationId" | "clerkUserId">;

// DEV_NOTE: Pending → Accepted (acceptedAt now) or Revoked; the DAL matches Pending rows only
export type UpdateAdminInviteStatusDALRequest = FindAdminInviteDALRequest & {
  status: AdminInvite["status"];
};
