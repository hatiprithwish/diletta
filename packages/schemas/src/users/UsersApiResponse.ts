import type { User } from "./UsersCommon";
import type { ApiResponse } from "../common";

export interface SyncClerkUserApiResponse extends ApiResponse {
  user?: User;
}

export interface GetUserDetailsApiResponse extends ApiResponse {
  user?: User;
}
