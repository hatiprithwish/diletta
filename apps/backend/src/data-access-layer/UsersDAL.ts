import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import getDbClient from "@/db/dbClient";
import { users } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

export default class UsersDAL {
  private db: DrizzleD1Database;

  constructor(env: Env) {
    this.db = getDbClient(env);
  }

  async getUserDetails(params: { clerkId: string }) {
    const response: Schemas.GetUserDetailsApiResponse = {
      isSuccess: false,
    };

    try {
      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.clerkId, params.clerkId))
        .limit(1);

      if (!user) {
        const message = "User not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetUserDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "User details fetched successfully";
      response.user = {
        publicId: user.publicId,
        clerkId: user.clerkId,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: user.role,
      };
    } catch (error) {
      const message = "Unknown error in fetching user details";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetUserDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }
    return response;
  }

  async upsertUser(params: Schemas.SyncClerkUserApiRequest) {
    const response: Schemas.SyncClerkUserApiResponse = {
      isSuccess: false,
    };
    try {
      const now = new Date();

      await this.db
        .insert(users)
        .values({
          publicId: Utility.generatePublicId(),
          clerkId: params.clerkId,
          email: params.email,
          role: params.role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: users.clerkId,
          set: {
            email: params.email,
            updatedAt: now,
          },
        });

      const userDetailsResponse = await this.getUserDetails({
        clerkId: params.clerkId,
      });

      if (!userDetailsResponse.user) {
        const message = "Failed to fetch user after upsert";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.SyncClerkUser,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "User synced successfully";
      response.user = userDetailsResponse.user;
    } catch (error) {
      const message = "Unknown error in syncing clerk user";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.SyncClerkUser,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }
    return response;
  }
}
