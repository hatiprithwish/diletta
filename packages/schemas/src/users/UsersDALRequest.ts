import type { UserRoleEnum } from "./UsersCommon";

export interface SyncClerkUserDALRequest {
  clerkId: string;
  email: string;
  role: UserRoleEnum;
}
