import type { Admin } from "./AdminsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface AdminDALResponse extends ApiResponse {
  admin?: Admin;
}
