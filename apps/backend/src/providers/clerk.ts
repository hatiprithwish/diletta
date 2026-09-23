import type { ClerkClient } from "@clerk/backend";
import { createClerkClient } from "@clerk/backend";

let clerkClient: ClerkClient | undefined;

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
}
