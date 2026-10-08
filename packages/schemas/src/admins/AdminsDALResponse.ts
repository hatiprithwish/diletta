import type { Admin } from "./AdminsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
// DEV_NOTE: For a lookup, isSuccess with no admin means no such row; isSuccess false means the query failed.
export interface AdminDALResponse extends ApiResponse {
  admin?: Admin;
}
