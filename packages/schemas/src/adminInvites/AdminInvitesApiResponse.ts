import type {
  AdminInviteStatusIntEnum,
  AdminInviteStatusLabelEnum,
  TeamFailureEnum,
} from "./AdminInvitesCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: A company admin as Settings › Team shows them, addressed by clerkUserId (admins carry no publicId).
// lastActiveAt comes from Clerk: null when they've never been active or Clerk couldn't be read (isLastActiveKnown).
export interface TeamMember {
  clerkUserId: string;
  name: string | null;
  email: string | null;
  isYou: boolean;
  lastActiveAt: string | null; // ISO time
  createdAt: string; // ISO time
}

// DEV_NOTE: A Pending invite. isEmailed false = the person already had an account: they get access at their next sign-in,
// and nobody emailed them.
export interface TeamInvite {
  publicId: string;
  email: string;
  status: AdminInviteStatusIntEnum;
  statusLabel: AdminInviteStatusLabelEnum;
  isEmailed: boolean;
  invitedByName: string | null;
  createdAt: string; // ISO time
}

export interface Team {
  members: TeamMember[];
  invites: TeamInvite[];
  isLastActiveKnown: boolean;
}

export interface GetTeamApiResponse extends ApiResponse {
  team?: Team;
}

export interface TeamWriteApiResponse extends ApiResponse {
  invite?: TeamInvite;
  failure?: TeamFailureEnum;
}
