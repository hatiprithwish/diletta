import type { PublicChatbotUser } from "./ChatbotUsersCommon";
import type { ApiResponse, TotalRecordsResponse } from "../common";

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

export type GetChatbotUsersCountApiResponse = TotalRecordsResponse;
