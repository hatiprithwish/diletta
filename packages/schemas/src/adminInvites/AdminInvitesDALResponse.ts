import type { AdminInvite } from "./AdminInvitesCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: isEmailTaken = the insert hit UNQ_admin_invites_company_id_email_pending (a Pending invite for that email)
export interface AdminInviteDALResponse extends ApiResponse {
  adminInvite?: AdminInvite;
  isEmailTaken?: boolean;
}

// DEV_NOTE: Pending invites with the inviting admin's name joined
export interface PendingAdminInvitesDALResponse extends ApiResponse {
  adminInvites?: (AdminInvite & { invitedByName: string | null })[];
}
