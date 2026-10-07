import type { ChatbotUser } from "./ChatbotUsersCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface ChatbotUserDALResponse extends ApiResponse {
  chatbotUser?: ChatbotUser;
}

export interface ChatbotUsersDALResponse extends ApiResponse {
  chatbotUsers?: ChatbotUser[];
}
