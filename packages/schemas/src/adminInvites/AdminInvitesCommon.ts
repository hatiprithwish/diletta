import { z } from "zod";

// DEV_NOTE: Settings › Team (M4-10). An invite to administer one company: Pending until the invitee's first sign-in
// accepts it (AdminsRepo.provisionAdmin, in the same transaction as the admins row) or an admin revokes it. The row
// decides: a Clerk user whose metadata names a Revoked or unknown invite gets no access.
export enum AdminInviteStatusIntEnum {
  Pending = 1,
  Accepted = 2,
  Revoked = 3,
}

export enum AdminInviteStatusLabelEnum {
  Pending = "Invited",
  Accepted = "Accepted",
  Revoked = "Revoked",
}

export const ADMIN_INVITE_STATUS_LABEL_MAP: Record<
  AdminInviteStatusIntEnum,
  AdminInviteStatusLabelEnum
> = {
  [AdminInviteStatusIntEnum.Pending]: AdminInviteStatusLabelEnum.Pending,
  [AdminInviteStatusIntEnum.Accepted]: AdminInviteStatusLabelEnum.Accepted,
  [AdminInviteStatusIntEnum.Revoked]: AdminInviteStatusLabelEnum.Revoked,
};

// DEV_NOTE: An email as invited: trimmed and lowercased, so one person can't hold two Pending invites by case
export const ZAdminInviteEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter an email address").max(320));

// Whole Admin Invite Body — DB shape
// DEV_NOTE: id, companyId and invitedBy are internal ids, never sent to a client. Exactly one of clerkInvitationId (an
// emailed Clerk invitation, for a new account) and clerkUserId (an existing Clerk account given the invite metadata,
// no email sent) is set.
export const ZAdminInvite = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  email: z.string(),
  status: z.enum(AdminInviteStatusIntEnum),
  clerkInvitationId: z.string().nullable(),
  clerkUserId: z.string().nullable(),
  invitedBy: z.string().nullable(),
  acceptedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AdminInvite = z.infer<typeof ZAdminInvite>;

// DEV_NOTE: The Clerk user public metadata keys an invite sets. companyPublicId predates M4-10 (operators' manual
// invites, docs/runbooks/operators.md); adminInvitePublicId ties the user to this invite row.
export const ADMIN_INVITE_METADATA_KEYS = {
  companyPublicId: "companyPublicId",
  adminInvitePublicId: "adminInvitePublicId",
} as const;

// DEV_NOTE: The Team page shows a company's admins and Pending invites together: one company's people, so it isn't paged
// (rule 3.17 covers lists that grow without bound); each part is capped here
export const TEAM_ADMINS_MAX = 200;
export const TEAM_PENDING_INVITES_MAX = 200;

// DEV_NOTE: Why an invite, revoke or remove changed nothing
export enum TeamFailureEnum {
  AlreadyAdmin = "AlreadyAdmin",
  AlreadyInvited = "AlreadyInvited",
  NotPending = "NotPending",
  CannotRemoveSelf = "CannotRemoveSelf",
  LastAdmin = "LastAdmin",
  ClerkUnavailable = "ClerkUnavailable",
}

export const TEAM_FAILURE_HTTP_STATUS_MAP: Record<TeamFailureEnum, 409 | 502> = {
  [TeamFailureEnum.AlreadyAdmin]: 409,
  [TeamFailureEnum.AlreadyInvited]: 409,
  [TeamFailureEnum.NotPending]: 409,
  [TeamFailureEnum.CannotRemoveSelf]: 409,
  [TeamFailureEnum.LastAdmin]: 409,
  [TeamFailureEnum.ClerkUnavailable]: 502,
};
