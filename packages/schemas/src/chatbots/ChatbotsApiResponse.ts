import type { ChatbotWithStatus } from "./ChatbotsCommon";
import type { ApiResponse } from "../common";

export interface CreateChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

export interface GetChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

export interface GetChatbotsApiResponse extends ApiResponse {
  chatbots?: ChatbotWithStatus[];
}

export interface UpdateChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}

export interface SetDefaultChatbotApiResponse extends ApiResponse {
  chatbot?: ChatbotWithStatus;
}
