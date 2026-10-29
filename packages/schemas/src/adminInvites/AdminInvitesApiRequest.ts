import { z } from "zod";
import { ZAdminInviteEmail } from "./AdminInvitesCommon";

// POST /dashboard/settings/team/invites
export const ZCreateAdminInviteApiRequest = z.object({
  email: ZAdminInviteEmail,
});
export type CreateAdminInviteApiRequest = z.infer<typeof ZCreateAdminInviteApiRequest>;
