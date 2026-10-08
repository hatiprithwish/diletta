import type { ClerkClient } from "@clerk/backend";
import { createClerkClient } from "@clerk/backend";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

let clerkClient: ClerkClient | undefined;

// DEV_NOTE: Key in the Clerk invite's publicMetadata naming the company the invitee administers (M4-10 sets it).
// publicMetadata is writable only from the Clerk backend, so a user can't set it on themselves.
const COMPANY_PUBLIC_ID_METADATA_KEY = "companyPublicId";

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

      return {
        isSuccess: true,
        profile: {
          email:
            user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null,
          name: user.fullName,
          companyPublicId: typeof companyPublicId === "string" ? companyPublicId : null,
        },
      };
    } catch (error) {
      const message = "Unknown error in fetching Clerk user";
      AppLogger.error({
        category: Schemas.LogCategory.Middleware,
        action: Schemas.LogAction.GetClerkAdminProfile,
        message,
        error,
        metadata: { clerkUserId },
      });
      return { isSuccess: false, message };
    }
  }
}
