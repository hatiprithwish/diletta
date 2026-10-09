import type { Message } from "./MessagesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface MessagesDALResponse extends ApiResponse {
  messages?: Message[];
}
