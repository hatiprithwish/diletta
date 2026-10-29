import type { ClerkClient } from "@clerk/backend";
import { createClerkClient } from "@clerk/backend";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

let clerkClient: ClerkClient | undefined;

// DEV_NOTE: Keys in the Clerk user's publicMetadata naming the company the invitee administers and the admin_invites row
// (Settings › Team, M4-10; Schemas.ADMIN_INVITE_METADATA_KEYS). publicMetadata is writable only from the Clerk backend,
// so a user can't set it on themselves.
const COMPANY_PUBLIC_ID_METADATA_KEY = Schemas.ADMIN_INVITE_METADATA_KEYS.companyPublicId;
const ADMIN_INVITE_METADATA_KEY = Schemas.ADMIN_INVITE_METADATA_KEYS.adminInvitePublicId;

export default class ClerkProvider {
  static getClerkClient(env: Env): ClerkClient {
    if (!clerkClient) {
      clerkClient = createClerkClient({
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        secretKey: env.CLERK_SECRET_KEY,
      });
    }
    return clerkClient;
  }

  // DEV_NOTE: Reads what AdminsRepo needs to provision an admin on first sign-in. Never throws.
  static async getAdminProfile(
    env: Env,
    clerkUserId: string,
  ): Promise<Schemas.GetClerkAdminProfileResponse> {
    try {
      const user = await ClerkProvider.getClerkClient(env).users.getUser(clerkUserId);
      const companyPublicId = user.publicMetadata[COMPANY_PUBLIC_ID_METADATA_KEY];
      const adminInvitePublicId = user.publicMetadata[ADMIN_INVITE_METADATA_KEY];

      return {
        isSuccess: true,
        profile: {
          email:
            user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null,
          name: user.fullName,
          companyPublicId: typeof companyPublicId === "string" ? companyPublicId : null,
          adminInvitePublicId: typeof adminInvitePublicId === "string" ? adminInvitePublicId : null,
        },
      };
    } catch (error) {
      const message = "Unknown error in fetching Clerk user";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.GetClerkAdminProfile,
        message,
        error,
        metadata: { clerkUserId },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: An invite is used once. After the admin is created, companyPublicId is removed from the Clerk user
  // (Clerk merges metadata; null deletes the key), so deleting the admins row later really revokes access instead
  // of the next /dashboard/me re-provisioning from the same metadata. Never throws.
  static async consumeInvite(env: Env, clerkUserId: string): Promise<Schemas.ApiResponse> {
    try {
      await ClerkProvider.getClerkClient(env).users.updateUserMetadata(clerkUserId, {
        publicMetadata: {
          [COMPANY_PUBLIC_ID_METADATA_KEY]: null,
          [ADMIN_INVITE_METADATA_KEY]: null,
        },
      });
      return { isSuccess: true };
    } catch (error) {
      const message = "Unknown error in consuming Clerk invite";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.ConsumeClerkInvite,
        message,
        error,
        metadata: { clerkUserId },
      });
      return { isSuccess: false, message };
    }
  }

  // ─── Settings › Team (M4-10). Every method never throws; emails stay out of the logs (PII).

  // DEV_NOTE: The Clerk account that owns an email, or null when nobody has signed up with it
  static async findUserByEmail(env: Env, email: string): Promise<Schemas.ClerkUserLookupResponse> {
    try {
      const { data } = await ClerkProvider.getClerkClient(env).users.getUserList({
        emailAddress: [email],
        limit: 1,
      });
      const user = data[0];
      return {
        isSuccess: true,
        clerkUserId: user?.id ?? null,
        hasPendingInvite:
          user !== undefined &&
          (typeof user.publicMetadata[ADMIN_INVITE_METADATA_KEY] === "string" ||
            typeof user.publicMetadata[COMPANY_PUBLIC_ID_METADATA_KEY] === "string"),
      };
    } catch (error) {
      const message = "Unknown error in finding Clerk user by email";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.FindClerkUserByEmail,
        message,
        error,
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: An emailed invitation for a new account. Accepting it signs the invitee up with the invite's metadata,
  // which their first /dashboard/me reads (AdminsRepo.provisionAdmin). ignoreExisting: another company's pending
  // invitation to the same email doesn't block this one (the admin_invites row decides which is honoured).
  static async createInvitation(
    env: Env,
    params: { email: string; companyPublicId: string; adminInvitePublicId: string },
  ): Promise<Schemas.ClerkInvitationResponse> {
    try {
      const invitation = await ClerkProvider.getClerkClient(env).invitations.createInvitation({
        emailAddress: params.email,
        redirectUrl: `${env.DASHBOARD_URL}/auth/sign-up`,
        publicMetadata: {
          [COMPANY_PUBLIC_ID_METADATA_KEY]: params.companyPublicId,
          [ADMIN_INVITE_METADATA_KEY]: params.adminInvitePublicId,
        },
        notify: true,
        ignoreExisting: true,
      });
      return { isSuccess: true, invitationId: invitation.id };
    } catch (error) {
      const message = "Unknown error in creating Clerk invitation";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.CreateClerkInvitation,
        message,
        error,
        metadata: { adminInvitePublicId: params.adminInvitePublicId },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: An existing account gets the invite's metadata directly (Clerk won't invite an existing user); their next
  // sign-in provisions them. No email is sent.
  static async grantInvite(
    env: Env,
    params: { clerkUserId: string; companyPublicId: string; adminInvitePublicId: string },
  ): Promise<Schemas.ApiResponse> {
    try {
      await ClerkProvider.getClerkClient(env).users.updateUserMetadata(params.clerkUserId, {
        publicMetadata: {
          [COMPANY_PUBLIC_ID_METADATA_KEY]: params.companyPublicId,
          [ADMIN_INVITE_METADATA_KEY]: params.adminInvitePublicId,
        },
      });
      return { isSuccess: true };
    } catch (error) {
      const message = "Unknown error in granting Clerk invite";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.GrantClerkInvite,
        message,
        error,
        metadata: {
          clerkUserId: params.clerkUserId,
          adminInvitePublicId: params.adminInvitePublicId,
        },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: Revoke invite, after the row is Revoked: a pending emailed invitation is revoked; a granted account loses
  // the metadata only while it still names this invite. Best effort: the row already refuses a sign-in.
  static async revokeInvite(
    env: Env,
    params: {
      clerkInvitationId: string | null;
      clerkUserId: string | null;
      adminInvitePublicId: string;
    },
  ): Promise<Schemas.ApiResponse> {
    try {
      const client = ClerkProvider.getClerkClient(env);
      if (params.clerkInvitationId) {
        // DEV_NOTE: Clerk revokes only a pending invitation; one already accepted, expired or revoked (a retry) needs
        // nothing more, since the admin_invites row decides access
        const { data } = await client.invitations.getInvitationList({
          query: params.clerkInvitationId,
          status: "pending",
        });
        if (data.some((invitation) => invitation.id === params.clerkInvitationId)) {
          await client.invitations.revokeInvitation(params.clerkInvitationId);
        }
      }
      if (params.clerkUserId) {
        const user = await client.users.getUser(params.clerkUserId);
        if (user.publicMetadata[ADMIN_INVITE_METADATA_KEY] === params.adminInvitePublicId) {
          await client.users.updateUserMetadata(params.clerkUserId, {
            publicMetadata: {
              [COMPANY_PUBLIC_ID_METADATA_KEY]: null,
              [ADMIN_INVITE_METADATA_KEY]: null,
            },
          });
        }
      }
      return { isSuccess: true };
    } catch (error) {
      const message = "Unknown error in revoking Clerk invite";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.RevokeClerkInvite,
        message,
        error,
        metadata: { adminInvitePublicId: params.adminInvitePublicId },
      });
      return { isSuccess: false, message };
    }
  }

  // DEV_NOTE: When each admin was last active, in one call (at most TEAM_ADMINS_MAX ids, under Clerk's page limit)
  static async getLastActive(
    env: Env,
    clerkUserIds: string[],
  ): Promise<Schemas.ClerkLastActiveResponse> {
    if (clerkUserIds.length === 0) return { isSuccess: true, lastActiveAt: {} };
    try {
      const { data } = await ClerkProvider.getClerkClient(env).users.getUserList({
        userId: clerkUserIds,
        limit: clerkUserIds.length,
      });
      return {
        isSuccess: true,
        lastActiveAt: Object.fromEntries(data.map((user) => [user.id, user.lastActiveAt])),
      };
    } catch (error) {
      const message = "Unknown error in reading Clerk last active";
      AppLogger.error({
        category: Schemas.LogCategory.Authz,
        action: Schemas.LogAction.GetClerkLastActive,
        message,
        error,
        metadata: { count: clerkUserIds.length },
      });
      return { isSuccess: false, message };
    }
  }
}
