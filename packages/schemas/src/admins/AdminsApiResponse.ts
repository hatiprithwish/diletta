import type { AdminContext, AdminProfile, ClerkAdminProfile } from "./AdminsCommon";
import type { ApiResponse } from "../common";

// DEV_NOTE: isSuccess with no admin = signed in to Clerk but no dashboard access (no admins row and no invite
// metadata); the route answers 403. isSuccess false = the lookup itself failed (500).
export interface GetMeApiResponse extends ApiResponse {
  admin?: AdminProfile;
}

// DEV_NOTE: Server-side only (auth middleware), never sent to a client: AdminContext carries internal ids.
// Same split as GetMeApiResponse: isSuccess with no admin = no admins row (403).
export interface GetAdminContextResponse extends ApiResponse {
  admin?: AdminContext;
}

// DEV_NOTE: Server-side only (ClerkProvider.getAdminProfile → AdminsRepo.getMe)
export interface GetClerkAdminProfileResponse extends ApiResponse {
  profile?: ClerkAdminProfile;
}
