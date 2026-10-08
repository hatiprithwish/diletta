import type { Admin, AdminContext, AdminProfile, ClerkAdminProfile } from "./AdminsCommon";
import type { Company } from "../companies";
import type { ApiResponse } from "../common";

// DEV_NOTE: isSuccess with no admin = signed in to Clerk but no dashboard access (no admins row and no invite, or
// the company has churned); the route answers 403. isSuccess false = the lookup itself failed (500).
export interface GetMeApiResponse extends ApiResponse {
  admin?: AdminProfile;
}

// DEV_NOTE: Server-side only (auth middleware), never sent to a client: AdminContext carries internal ids.
// Same split as GetMeApiResponse: isSuccess with no admin = no admins row, or a churned company (403).
export interface GetAdminContextResponse extends ApiResponse {
  admin?: AdminContext;
}

// DEV_NOTE: Server-side only (ClerkProvider.getAdminProfile → AdminsRepo.getMe)
export interface GetClerkAdminProfileResponse extends ApiResponse {
  profile?: ClerkAdminProfile;
}

// DEV_NOTE: Server-side only (AdminsRepo): the admins row and, for a company admin, their company. isSuccess with
// no admin = no dashboard access (no row, or a churned company).
export interface ResolvedAdminResponse extends ApiResponse {
  admin?: Admin;
  company?: Company;
}
