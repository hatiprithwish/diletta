import type { PublicChatbotUser } from "./ChatbotUsersCommon";
import type { ApiResponse } from "../common";

export interface CreateChatbotUserApiResponse extends ApiResponse {
  chatbotUser?: PublicChatbotUser;
}

export interface GetChatbotUserApiResponse extends ApiResponse {
  chatbotUser?: PublicChatbotUser;
}

export interface GetChatbotUsersApiResponse extends ApiResponse {
  chatbotUsers?: PublicChatbotUser[];
}

export interface UpdateChatbotUserApiResponse extends ApiResponse {
  chatbotUser?: PublicChatbotUser;
}
